import { describe, expect, it } from "vitest";
import { createAgentPlan } from "./plan";

const step = (id: string, status = "pending", dependsOn: string[] = []) => ({ id, title: id, status, dependsOn });
describe("Agent work plan", () => {
  it("accepts twelve steps and rejects empty or oversized plans", () => {
    const steps = Array.from({ length: 12 }, (_, index) => step(`step-${index}`));
    expect(createAgentPlan({ goal: "Batch workflow", steps } as never).steps).toHaveLength(12);
    expect(() => createAgentPlan({ goal: "Batch workflow", steps: [] })).toThrow();
    expect(() => createAgentPlan({ goal: "Batch workflow", steps: [...steps, step("extra")] } as never)).toThrow();
  });
  it("keeps a stable plan ID across progress updates and validates dependency readiness", () => {
    const plan = createAgentPlan({ goal: "Translate and export", steps: [step("import", "completed"), step("translate", "in_progress", ["import"])] } as never);
    expect(createAgentPlan({ goal: plan.goal, steps: plan.steps }, plan).id).toBe(plan.id);
    expect(() => createAgentPlan({ goal: plan.goal, steps: [step("import"), step("translate", "in_progress", ["import"])] } as never)).toThrow(/dependencies/);
  });
  it.each([
    [step("a"), step("a")],
    [step("a", "in_progress"), step("b", "in_progress")],
    [step("a", "pending", ["b"]), step("b", "pending", ["a"])],
    [step("a", "pending", ["missing"])],
    [step("a", "completed", ["b"]), step("b")],
  ])("rejects incoherent plans: %j", (...steps) => {
    expect(() => createAgentPlan({ goal: "Goal", steps } as never)).toThrow();
  });
});
