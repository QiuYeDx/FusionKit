import { describe, expect, it } from "vitest";
import { isExplicitRenameConfirmation } from "./name-plan-confirmation";

describe("rename plan confirmation", () => {
  it.each([
    "确认执行",
    "应用刚才的重命名计划",
    "执行这个 plan",
    "确认重命名",
    "Apply this rename plan",
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
});
