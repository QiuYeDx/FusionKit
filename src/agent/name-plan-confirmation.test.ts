import { describe, expect, it } from "vitest";
import { isExplicitRenameConfirmation } from "./name-plan-confirmation";

describe("rename plan confirmation", () => {
  it.each([
    "确认执行",
    "应用刚才的重命名计划",
    "执行这个 plan",
    "确认重命名",
    "Apply this rename plan",
    "请确认执行当前重命名计划。",
    "I confirm this rename plan.",
    "Please apply this rename plan!",
  ])("accepts explicit confirmation: %s", (text) => {
    expect(isExplicitRenameConfirmation(text, "rename_plan_abcdef12")).toBe(
      true
    );
  });

  it.each(["看起来不错", "可以", "嗯", "继续", "可以执行吗"])(
    "rejects vague confirmation: %s",
    (text) => {
      expect(isExplicitRenameConfirmation(text, "rename_plan_abcdef12")).toBe(
        false
      );
    }
  );

  it("accepts explicit action with a plan id", () => {
    expect(
      isExplicitRenameConfirmation(
        "执行 rename_plan_abcdef12",
        "rename_plan_abcdef12"
      )
    ).toBe(true);
  });

  it.each(["不要执行这个重命名计划", "不要确认执行", "先不应用 rename_plan_abcdef12", "如果没问题就确认执行", "Do not apply this rename plan", "Don't execute rename_plan_abcdef12", "Can you apply this plan", "Wait before applying this rename plan"]) ("rejects negative or conditional confirmation: %s", text => {
    expect(isExplicitRenameConfirmation(text, "rename_plan_abcdef12")).toBe(false);
  });

  it.each([
    "我还没确认执行这个重命名计划", "我尚未确认这个重命名计划", "我不想确认执行这个计划",
    "I haven't confirmed this rename plan", "I haven’t confirmed this rename plan", "I won't apply this rename plan",
    "解释一下确认执行这个计划的含义", "确认执行是指什么", "用户说：确认执行", "\"确认执行\"",
    "Apply this rename plan if the names look fine", "I previously confirmed this rename plan",
    "我确认执行这个计划，但稍后再做", "帮我检查是否应该应用这个计划",
  ])("rejects denial, quoted text and non-command mentions: %s", text => {
    expect(isExplicitRenameConfirmation(text, "rename_plan_abcdef12")).toBe(false);
  });
});
