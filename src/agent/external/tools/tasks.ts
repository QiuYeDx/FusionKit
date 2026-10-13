import type { z } from "zod";
import type { EXTERNAL_TOOLS } from "../catalog";
import { checkActive, ExternalToolError, type ExternalToolContext } from "../errors";
import { bounded, studioApi, unwrapStudio } from "./studio";

type TasksInput = z.output<typeof EXTERNAL_TOOLS.get_studio_tasks.inputSchema>;

export async function getStudioTasks(input: TasksInput, ctx: ExternalToolContext) {
  if (input.kind === "translation") {
    const snapshot = unwrapStudio(await studioApi().listTranslationTasks({ offset: input.offset, pageSize: input.limit }));
    checkActive(ctx);
    return { kind: input.kind, total: snapshot.total, counts: snapshot.counts, offset: input.offset,
      items: snapshot.items.slice(0, input.limit).map(item => ({ documentId: item.documentId, revision: item.revision, taskId: item.taskId,
        name: bounded(item.displayName), status: item.status, completedBatches: item.completedBatches, totalBatches: item.totalBatches, ...(item.error ? { error: item.error } : {}) })) };
  }
  const result = await studioApi().listTranscriptionTasks({});
  checkActive(ctx);
  if (!result.ok) throw new ExternalToolError("transcription_unavailable", { reason: result.error });
  const tasks = result.value;
  return { kind: input.kind, total: tasks.length, offset: input.offset,
    items: tasks.slice(input.offset, input.offset + input.limit).map(item => ({ taskId: item.taskId, batchId: item.batchId, name: bounded(item.displayName),
      status: item.status, progress: item.progress, documentId: item.documentId ?? null, ...(item.error ? { error: item.error.code } : {}) })) };
}
