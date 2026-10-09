import { z } from "zod";
import { agentPlanInputSchema } from "./plan";
import type { SessionExportData } from "./types";

export const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const text = z.string().max(1_000_000);
const id = z.string().min(1).max(200);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.number().finite().nonnegative().max(8_640_000_000_000_000);
const amount = z.number().finite().nonnegative();
const data = z.record(z.string(), z.unknown());
const usage = z.object({ promptTokens: count, completionTokens: count, totalTokens: count });
const message = z.object({
  id, role: z.enum(["user", "assistant", "system", "tool"]), content: text, timestamp: time,
  toolCalls: z.array(z.object({ toolCallId: id, toolName: id, args: data, responseItemId: id.optional() })).max(64).optional(),
  toolResult: z.object({ callId: id, toolName: id, success: z.boolean(), data: z.unknown().optional(), error: text.optional() }).optional(),
  event: z.object({
    kind: z.enum(["rename_applied", "rename_failed", "rename_dismissed", "action_completed", "action_failed", "action_dismissed", "execution_confirmed", "execution_dismissed", "pipeline_completed"]),
    values: z.record(z.string().max(100), z.union([z.string().max(2000), z.number().finite(), z.boolean()])).optional(),
  }).optional(),
}).superRefine((value, context) => {
  if (value.role === "tool" && !value.toolResult) context.addIssue({ code: "custom", message: "Tool messages require a result." });
  if (value.toolCalls && value.role !== "assistant") context.addIssue({ code: "custom", message: "Only assistant messages may contain tool calls." });
  if (value.event && value.role !== "user") context.addIssue({ code: "custom", message: "Only user-turn messages may carry interface events." });
});
const plan = z.object({ id, goal: z.string(), steps: z.array(z.unknown()), updatedAt: time }).transform((value, context) => {
  const parsed = agentPlanInputSchema.safeParse({ goal: value.goal, steps: value.steps });
  if (!parsed.success) { context.addIssue({ code: "custom", message: "Invalid work plan." }); return z.NEVER; }
  return { ...value, ...parsed.data };
});

export const sessionExportSchema = z.object({
  version: z.literal(1), exportedAt: time,
  executionMode: z.enum(["queue_only", "ask_before_execute", "auto_execute"]),
  session: z.object({
    id, messages: z.array(message).max(10_000), status: z.enum(["idle", "thinking", "streaming", "error"]),
    createdAt: time, updatedAt: time, plan: plan.optional(),
  }),
  tokenStats: z.object({
    totalPromptTokens: count, totalCompletionTokens: count, totalTokens: count, totalCost: amount,
    stepCount: count, lastPromptTokens: count,
    interactions: z.array(usage.extend({ timestamp: time, cost: amount, stepCount: count })).max(10_000),
  }),
  sessionLog: z.array(z.object({
    id, timestamp: time,
    type: z.enum(["user_message", "assistant_message", "status_change", "tool_call", "tool_result", "tool_result_committed", "name_translation_plan", "name_translation_apply", "subtitle_recovery_scan", "subtitle_recovery_queue", "usage", "error", "abort", "session_reset"]),
    summary: text, data: data.optional(),
  })).max(20_000),
});

export function parseSessionJson(json: string): SessionExportData {
  if (typeof json !== "string" || json.length > MAX_SESSION_BYTES || new TextEncoder().encode(json).byteLength > MAX_SESSION_BYTES) {
    throw new Error("Session file exceeds the 8 MiB limit.");
  }
  const result = sessionExportSchema.safeParse(JSON.parse(json));
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(`Invalid session at ${first.path.join(".") || "root"}: ${first.message}`);
  }
  return result.data;
}
