import { describe, expect, it } from "vitest";
import { shouldFollowUpUiEvent, uiEventModelText } from "./ui-events";

describe("applied revision events", () => {
  const withHints = { kind: "revision_applied" as const, values: { count: 3, hintCount: 1, hints: "テイムフィールド家のお嬢様 → 泰姆菲尔德家的大小姐" } };
  const without = { kind: "revision_applied" as const, values: { count: 2, hintCount: 0, hints: "" } };
  it("tells the agent what was applied and which wordings it settled", () => {
    expect(uiEventModelText(withHints)).toContain("3 cue(s) changed");
    expect(uiEventModelText(withHints)).toContain("テイムフィールド家のお嬢様 → 泰姆菲尔德家的大小姐");
    expect(uiEventModelText(without)).toContain("settled no wording worth keeping");
    expect(uiEventModelText(without)).toContain("authorizes nothing new");
    expect(uiEventModelText({ kind: "revision_applied", values: { count: 4, hintCount: 0, hints: "", merged: 1, deleted: 1, retimed: 1 } }))
      .toContain("4 cue(s) changed (1 merge(s), 1 deletion(s), 1 time change(s))");
  });
  it("follows up only when there are wordings to keep or an open plan", () => {
    expect(shouldFollowUpUiEvent(withHints, undefined)).toBe(true);
    expect(shouldFollowUpUiEvent(without, undefined)).toBe(false);
    expect(shouldFollowUpUiEvent(without, { id: "p", goal: "g", updatedAt: 1, steps: [{ id: "s", title: "t", status: "in_progress" }] } as never)).toBe(true);
  });
});
