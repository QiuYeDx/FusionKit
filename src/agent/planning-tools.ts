import { tool } from "ai";
import { z } from "zod";
import useAgentStore from "@/store/agent/useAgentStore";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";
import { agentPlanInputSchema } from "./plan";

export const planningAgentTools = {
  get_classic_subtitle_tasks: tool({
    description: "Read actual queue status for classic subtitle translation, conversion and language extraction. Use returned task references to distinguish the requested files; queued or running does not mean completed. Returns bounded metadata, no file contents or credentials.",
    inputSchema: z.object({
      store: z.enum(["all", "translate", "convert", "extract"]).default("all"),
      offset: z.number().int().min(0).max(100000).default(0),
      limit: z.number().int().min(1).max(50).default(20),
    }).strict(),
    execute: async ({ store, offset, limit }, options) => {
      options.abortSignal?.throwIfAborted();
      const items: Array<{ store: string; taskId?: string; fileName: string; status: string; progress: number }> = [];
      if (store === "all" || store === "translate") {
        const state = useSubtitleTranslatorStore.getState();
        for (const [status, tasks] of [["queued", state.notStartedTaskQueue], ["queued", state.waitingTaskQueue], ["running", state.pendingTaskQueue], ["completed", state.resolvedTaskQueue], ["failed", state.failedTaskQueue]] as const) {
          for (const task of tasks) items.push({ store: "translate", taskId: task.taskId, fileName: task.fileName.slice(0, 255), status, progress: task.progress ?? 0 });
        }
      }
      for (const key of ["convert", "extract"] as const) {
        if (store !== "all" && store !== key) continue;
        const state = key === "convert" ? useSubtitleConverterStore.getState() : useSubtitleExtractorStore.getState();
        for (const [status, tasks] of [["queued", state.notStartedTasks], ["running", state.pendingTasks], ["completed", state.resolvedTasks], ["failed", state.failedTasks]] as const) {
          for (const task of tasks) items.push({ store: key, ...("agentTaskId" in task && typeof task.agentTaskId === "string" ? { taskId: task.agentTaskId } : {}), fileName: task.fileName.slice(0, 255), status, progress: task.progress ?? 0 });
        }
      }
      return { success: true, data: { total: items.length, offset, hasMore: offset + limit < items.length, items: items.slice(offset, offset + limit) } };
    },
  }),
  update_agent_plan: tool({
    description: "Create or revise a visible work plan for complex or multi-tool requests. Use stable step IDs and dependencies; at most one step is in_progress. Record outcomes or blockers in detail. Queuing a task completes only a queueing step, never the underlying processing. Do not create plans for casual chat.",
    inputSchema: agentPlanInputSchema,
    execute: async (input, options) => {
      options.abortSignal?.throwIfAborted();
      try {
        return { success: true, data: { plan: useAgentStore.getState().updatePlan(input) } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  }),
};
