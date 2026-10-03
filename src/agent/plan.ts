import { z } from "zod";
import type { AgentPlan } from "./types";

export const agentPlanInputSchema = z.object({
  goal: z.string().trim().min(1).max(500),
  steps: z.array(z.object({
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(300),
    status: z.enum(["pending", "in_progress", "completed", "blocked"]),
    dependsOn: z.array(z.string().min(1).max(80)).max(12).default([]),
    detail: z.string().max(1000).optional(),
  }).strict()).min(1).max(12),
}).strict().superRefine(({ steps }, context) => {
  const ids = new Map(steps.map((step) => [step.id, step]));
  if (ids.size !== steps.length) context.addIssue({ code: "custom", message: "Step IDs must be unique." });
  if (steps.filter((step) => step.status === "in_progress").length > 1) {
    context.addIssue({ code: "custom", message: "Only one step can be in progress." });
  }
  for (const step of steps) {
    if (new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some((id) => !ids.has(id) || id === step.id)) {
      context.addIssue({ code: "custom", message: `Invalid dependencies for ${step.id}.` });
    }
    if (["in_progress", "completed"].includes(step.status) && step.dependsOn.some((id) => ids.get(id)?.status !== "completed")) {
      context.addIssue({ code: "custom", message: `Complete dependencies before ${step.id}.` });
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of ids.get(id)?.dependsOn ?? []) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  if (steps.some((step) => !visit(step.id))) context.addIssue({ code: "custom", message: "Plan dependencies must not form a cycle." });
});

export type AgentPlanInput = z.input<typeof agentPlanInputSchema>;

export function createAgentPlan(input: AgentPlanInput, previous?: AgentPlan): AgentPlan {
  const parsed = agentPlanInputSchema.parse(input);
  return {
    ...parsed,
    id: previous?.goal === parsed.goal ? previous.id : `plan-${crypto.randomUUID()}`,
    updatedAt: Date.now(),
  };
}
