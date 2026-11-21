import type { z } from "zod";
import type { EXTERNAL_TOOLS } from "../catalog";
import { checkActive, ExternalToolError, type ExternalToolContext } from "../errors";
import { bounded, unwrapStudio, studioApi } from "./studio";

type ReviewInput = z.output<typeof EXTERNAL_TOOLS.list_studio_transcription_review.inputSchema>;

/**
 * The ranges of a Japanese/ASMR task that wait for a listening check. Main answers per owner, so a task of another
 * window reads as not found rather than as empty.
 */
export async function listStudioTranscriptionReview(input: ReviewInput, ctx: ExternalToolContext) {
  const result = await studioApi().listTranscriptionReview({ taskId: input.taskId, offset: input.offset, limit: input.limit });
  checkActive(ctx);
  if (!result.ok) throw new ExternalToolError(result.error, { reason: result.error });
  return { taskId: input.taskId, total: result.value.total, offset: input.offset, nextOffset: input.offset + result.value.ranges.length < result.value.total ? input.offset + result.value.ranges.length : null,
    items: result.value.ranges.map(range => ({ startMs: range.startMs, endMs: range.endMs, reason: range.reason,
      ...(range.cue ? { cue: { cueId: range.cue.id, index: range.cue.index, text: bounded(range.cue.text, 120) } } : {}) })) };
}
