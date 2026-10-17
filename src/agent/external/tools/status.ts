import i18n from "@/i18n";
import useModelStore from "@/store/useModelStore";
import { usePageContextStore } from "@/agent/page-context";
import type { ModelProfile } from "@/type/model";
import { useExternalAgentStore } from "../store";
import { checkActive, type ExternalToolContext } from "../errors";
import { studioApi, unwrapStudio } from "./studio";

const ACTIVE_TRANSCRIPTION = new Set(["queued", "preparing_media", "loading_model", "transcribing", "post_processing"]);

/** Whether a model is set up and what it is called; never its key or address. */
function modelState(profile: ModelProfile | null) {
  return profile && profile.apiKey.trim() && profile.modelKey.trim()
    ? { configured: true, name: profile.name.slice(0, 100), model: profile.modelKey.slice(0, 100) }
    : { configured: false };
}

async function studioState(ctx: ExternalToolContext) {
  try {
    const api = studioApi();
    const library = unwrapStudio(await api.listDocuments({ offset: 0, pageSize: 1 })); checkActive(ctx);
    const translations = unwrapStudio(await api.listTranslationTasks({ offset: 0, pageSize: 1 })); checkActive(ctx);
    // The transcription runtime may be unavailable (no local resources yet) while the library works.
    const transcriptions = await api.listTranscriptionTasks({}); checkActive(ctx);
    return {
      available: true,
      documentCount: library.allTotal ?? library.total,
      unavailableDocumentCount: library.unavailableDocuments,
      translationTasks: { queued: translations.counts.queued ?? 0, running: translations.counts.running ?? 0, needsAttention: (translations.counts.failed ?? 0) + (translations.counts.interrupted ?? 0) + (translations.counts.needs_configuration ?? 0) },
      transcriptionTasks: transcriptions.ok ? { available: true, active: transcriptions.value.filter(task => ACTIVE_TRANSCRIPTION.has(task.status)).length } : { available: false },
    };
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    return { available: false };
  }
}

export async function getFusionkitStatus(_input: Record<string, never>, ctx: ExternalToolContext) {
  const models = useModelStore.getState();
  const status = useExternalAgentStore.getState().status;
  return {
    app: "FusionKit",
    version: import.meta.env.VITE_APP_VERSION ?? "",
    interfaceLanguage: i18n.resolvedLanguage ?? i18n.language,
    currentPage: usePageContextStore.getState().pathname,
    trust: status?.trust ?? "confirm_writes",
    ...(status?.trust === "custom" ? { permissions: status.permissions } : {}),
    fusionkitModels: { agent: modelState(models.getAgentProfile()), taskExecution: modelState(models.getTaskProfile()) },
    subtitleStudio: await studioState(ctx),
  };
}
