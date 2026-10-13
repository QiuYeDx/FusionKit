import type { z } from "zod";
import { getStudioTranscriptionController, getTranscriptionReadiness, type StudioTranscriptionState } from "@/services/subtitle-studio/transcription-controller";
import { transcriptionTaskConfigSchema } from "@/subtitle-studio/transcription/task-contract";
import type { EXTERNAL_TOOLS } from "../catalog";
import { confirmed, pathItem } from "../confirmations";
import { checkActive, ExternalToolError, type ExternalToolContext } from "../errors";
import { bounded, studioApi } from "./studio";

type TranscriptionInput = z.output<typeof EXTERNAL_TOOLS.start_studio_transcription.inputSchema>;

/** Why the runtime or model cannot take a batch now, ignoring that no media is chosen yet. */
function runtimeProblem(state: StudioTranscriptionState): string | null {
  const reason = getTranscriptionReadiness({ ...state, drafts: [{ status: "ready" }] } as unknown as StudioTranscriptionState).reason;
  return reason;
}

export async function startStudioTranscription(input: TranscriptionInput, ctx: ExternalToolContext) {
  studioApi();
  const controller = getStudioTranscriptionController();
  await controller.refresh(); checkActive(ctx);
  const before = controller.getState();
  // The user's own drafts on the Studio page are theirs: never touch them.
  if (before.drafts.length || before.selecting || before.submitting) throw new ExternalToolError("transcription_drafts_pending", { hint: "The user has unsubmitted transcription drafts in Subtitle Studio." });
  const config = transcriptionTaskConfigSchema.safeParse({ ...before.config, ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.language ? { language: input.language } : {}) });
  if (!config.success) throw new ExternalToolError("transcription_configuration_invalid");
  const problem = runtimeProblem({ ...before, config: config.data, autoTranslation: { ...before.autoTranslation, enabled: false } });
  if (problem) throw new ExternalToolError("transcription_not_ready", { reason: problem, hint: "Install the runtime and a model in Subtitle Studio's transcription view first." });

  return confirmed(ctx, "start_studio_transcription", {
    action: "transcription", summary: "transcription", values: { count: input.paths.length, model: config.data.modelId, language: config.data.language }, items: input.paths.map(pathItem),
  }, async () => {
    const current = controller.getState();
    if (current.drafts.length || current.selecting || current.submitting) throw new ExternalToolError("transcription_drafts_pending");
    const savedConfig = current.config;
    const savedAutomatic = current.autoTranslation;
    const owned: string[] = [];
    const restore = () => {
      for (const draft of controller.getState().drafts) if (owned.includes(draft.id) && !["submitting", "submission_unknown"].includes(draft.status)) controller.removeDraft(draft.id);
      controller.setAutoTranslation(savedAutomatic);
      controller.setConfig(savedConfig);
    };
    try {
      // This batch only: no automatic translation (the agent translates) and no automatic export.
      controller.setConfig(config.data);
      controller.setAutoTranslation({ ...savedAutomatic, enabled: false });
      const page = await controller.selectMediaFromPaths({ paths: input.paths, ...(input.recursive ? { recursive: true } : {}) });
      const selected = controller.getState();
      owned.push(...selected.drafts.map(draft => draft.id));
      if (!page || page.matched === 0 || !owned.length) throw new ExternalToolError(selected.error ?? "no_media_found");
      const readiness = getTranscriptionReadiness(selected);
      if (!readiness.canEnqueue || readiness.readyCount !== owned.length) {
        throw new ExternalToolError(readiness.reason ? "transcription_not_ready" : "media_not_ready", {
          ...(readiness.reason ? { reason: readiness.reason } : {}),
          files: selected.drafts.slice(0, 20).map(draft => ({ name: bounded(draft.displayName), status: draft.status, ...(draft.error ? { error: draft.error } : {}) })),
        });
      }
      const admission = await controller.enqueue({ expectedDraftIds: owned, autoExport: null });
      if (!admission) throw new ExternalToolError(controller.getState().error ?? "transcription_not_admitted");
      return {
        batchId: admission.batchId, status: "queued", ...(page.nextOffset !== undefined ? { moreMediaNotQueued: true } : {}),
        tasks: admission.tasks.map(task => ({ taskId: task.taskId, name: bounded(task.displayName), status: task.status })),
        next: "Follow progress with get_studio_tasks(kind=transcription); a completed task has a documentId.",
      };
    } finally {
      restore();
    }
  });
}
