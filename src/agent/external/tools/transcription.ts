import type { z } from "zod";
import { getStudioTranscriptionController, getTranscriptionReadiness } from "@/services/subtitle-studio/transcription-controller";
import { agentTranscriptionMismatch, planAgentTranscription } from "@/services/subtitle-studio/transcription-batch-mode";
import { useStudioPreferences } from "@/store/tools/subtitle-studio/preferences";
import type { EXTERNAL_TOOLS } from "../catalog";
import { confirmed, pathItem } from "../confirmations";
import { checkActive, ExternalToolError, type ExternalToolContext } from "../errors";
import { bounded, studioApi } from "./studio";

type TranscriptionInput = z.output<typeof EXTERNAL_TOOLS.start_studio_transcription.inputSchema>;
const MODEL_MISMATCH_HINTS = {
  recognize_only: "This model only recognizes existing Studio cues again. Transcribe with a whole-media model (such as large-v3-q5_0) first.",
  language: "This model recognizes only its own language: pass that language, or choose another model.",
} as const;

/** Why the runtime or model cannot take a batch now, ignoring that no media is chosen yet. */
function runtimeProblem(state: Parameters<typeof getTranscriptionReadiness>[0], mode: Parameters<typeof getTranscriptionReadiness>[1]): string | null {
  const reason = getTranscriptionReadiness({ ...state, drafts: [{ status: "ready" }] } as unknown as Parameters<typeof getTranscriptionReadiness>[0], mode).reason;
  return reason;
}

export async function startStudioTranscription(input: TranscriptionInput, ctx: ExternalToolContext) {
  studioApi();
  const controller = getStudioTranscriptionController();
  await controller.refresh(); checkActive(ctx);
  const before = controller.getState();
  // The user's own drafts on the Studio page are theirs: never touch them.
  if (before.drafts.length || before.selecting || before.submitting) throw new ExternalToolError("transcription_drafts_pending", { hint: "The user has unsubmitted transcription drafts in Subtitle Studio." });
  // This batch's mode is the caller's choice; leaving it out follows Settings → Assistant, never the page's mode.
  // Settings only the standard pipeline has are left unused rather than changing the requested mode; naming
  // Japanese/ASMR itself along with them is a contradiction the caller can see, so that one is refused.
  const plan = planAgentTranscription(before, input, useStudioPreferences.getState().agentTranscriptionMode);
  // The assistant-facing codes drop the Studio page's prefix: this mode is the caller's own choice.
  if (!plan.ok) throw new ExternalToolError(plan.error.replace(/^studio_/u, ""), plan.hint ? { hint: plan.hint } : undefined);
  // A model that only recognizes cues again, or a language the model cannot be told, is refused with the reason
  // (it would otherwise read as "not ready"); settings from the Studio page fall back as they do there.
  const mismatch = agentTranscriptionMismatch(plan, input);
  if (mismatch === "recognize_only" || (mismatch === "language" && input.language)) {
    throw new ExternalToolError("transcription_model_unsupported", { reason: mismatch, hint: MODEL_MISMATCH_HINTS[mismatch] });
  }
  const problem = runtimeProblem({ ...before, config: plan.mode === "standard" ? plan.config : before.config,
    autoTranslation: { ...before.autoTranslation, enabled: false } }, plan.mode);
  if (problem) throw new ExternalToolError("transcription_not_ready", { reason: problem, hint: plan.mode === "japanese_asmr"
    ? "Japanese/ASMR needs its voice-detection model and the Japanese recognition model; install both in Subtitle Studio's transcription view, or call again with mode standard."
    : "Install the runtime and a model in Subtitle Studio's transcription view first." });

  return confirmed(ctx, "start_studio_transcription", {
    action: "transcription", summary: "transcription", values: { count: input.paths.length, mode: plan.mode, model: plan.mode === "japanese_asmr" ? "Japanese/ASMR" : plan.config.modelId, language: plan.config.language },
    items: input.paths.map(pathItem),
  }, async () => {
    const current = controller.getState();
    if (current.drafts.length || current.selecting || current.submitting) throw new ExternalToolError("transcription_drafts_pending");
    const savedConfig = current.config;
    const savedAutomatic = current.autoTranslation;
    const owned: string[] = [];
    // Only a standard batch writes the page's config, so only that is put back.
    const restore = () => {
      for (const draft of controller.getState().drafts) if (owned.includes(draft.id) && !["submitting", "submission_unknown"].includes(draft.status)) controller.removeDraft(draft.id);
      controller.setAutoTranslation(savedAutomatic);
      if (plan.mode === "standard") controller.setConfig(savedConfig);
    };
    try {
      // This batch only: no automatic translation (the agent translates) and no automatic export.
      if (plan.mode === "standard") controller.setConfig(plan.config);
      controller.setAutoTranslation({ ...savedAutomatic, enabled: false });
      const page = await controller.selectMediaFromPaths({ paths: input.paths, ...(input.recursive ? { recursive: true } : {}) });
      const selected = controller.getState();
      owned.push(...selected.drafts.map(draft => draft.id));
      if (!page || page.matched === 0 || !owned.length) throw new ExternalToolError(selected.error ?? "no_media_found");
      const readiness = getTranscriptionReadiness(selected, plan.mode);
      if (!readiness.canEnqueue || readiness.readyCount !== owned.length) {
        throw new ExternalToolError(readiness.reason ? "transcription_not_ready" : "media_not_ready", {
          ...(readiness.reason ? { reason: readiness.reason } : {}),
          files: selected.drafts.slice(0, 20).map(draft => ({ name: bounded(draft.displayName), status: draft.status, ...(draft.error ? { error: draft.error } : {}) })),
        });
      }
      const admission = await controller.enqueue({ expectedDraftIds: owned, autoExport: null, mode: plan.mode, holdOnReview: false });
      if (!admission) throw new ExternalToolError(controller.getState().error ?? "transcription_not_admitted");
      return {
        batchId: admission.batchId, status: "queued", mode: plan.mode, ...(page.nextOffset !== undefined ? { moreMediaNotQueued: true } : {}),
        // Saying which settings went unused stops the caller from assuming they applied.
        ...(plan.ignoredSettings?.length ? { ignoredSettings: plan.ignoredSettings,
          note: `Ran as ${plan.mode === "japanese_asmr" ? "Japanese/ASMR" : "standard"}; ${plan.ignoredSettings.join(", ")} ${plan.ignoredSettings.length > 1 ? "were" : "was"} not used because this pipeline sets ${plan.ignoredSettings.length > 1 ? "them" : "it"} itself.` } : {}),
        tasks: admission.tasks.map(task => ({ taskId: task.taskId, name: bounded(task.displayName), status: task.status })),
        next: "Follow progress with get_studio_tasks(kind=transcription); a completed task has a documentId, and a japanese_asmr task may report reviewCount ranges for list_studio_transcription_review.",
      };
    } finally {
      restore();
    }
  });
}
