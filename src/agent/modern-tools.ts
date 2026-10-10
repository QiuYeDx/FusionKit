import { tool } from "ai";
import { z } from "zod";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import useLocalSubtitleTranscriberStore from "@/store/tools/subtitle/useLocalSubtitleTranscriberStore";
import { getStudioTranscriptionController, getTranscriptionReadiness } from "@/services/subtitle-studio/transcription-controller";
import { getStudioTranslationOverviewController } from "@/services/subtitle-studio/translation-overview-controller";
import { translationConfigSchema, normalizeTranslationModel } from "@/subtitle-studio/translation-contract";
import { encodingSchema } from "@/subtitle-studio/domain";
import { transcriptionTaskConfigSchema } from "@/subtitle-studio/transcription/task-contract";
import type { DocumentSummary, StudioResult } from "@/subtitle-studio/ipc-contract";
import { AGENT_CAPABILITIES } from "./capability-catalog";
import { SettingsResolver } from "./tool-page-settings";
import { translationDraftMemory } from "@/services/subtitle-studio/translation-draft";
import i18n from "@/i18n";
import { userMentionedPath } from "./user-intent-authority";
import { watchStudioPipeline } from "./pipeline-watch";
import { automaticExportFromPreferences, type AutomaticExportSpec } from "@/subtitle-studio/automatic-export-contract";
import { registerPreparedAction, usePreparedActionsStore, type PreparedAction, type PreparedActionReceipt, type PreparedActionResult } from "./prepared-actions";

export interface Context { sessionId: string; signal?: AbortSignal; check: () => void }
export const page = { offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(20) };
export const id = z.string().uuid();
const language = z.string().trim().min(2).max(32).regex(/^(?:auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/);
export const safeText = (value: string, length = 255) => value.slice(0, length);
export class ToolFailure extends Error {}
export const failed = (error: string, data?: unknown): PreparedActionResult => ({ success: false, error, ...(data !== undefined ? { data } : {}) });
export const succeeded = (data: unknown): PreparedActionResult => ({ success: true, data });
function receipt(phase: PreparedActionReceipt["phase"], items: PreparedActionReceipt["items"]): PreparedActionReceipt {
  const bounded = items.slice(0, 50).map(item => ({ ...item, name: safeText(item.name) }));
  const failureCount = bounded.filter(item => item.status === "failed").length;
  return { phase, total: bounded.length, successCount: bounded.length - failureCount, failureCount, items: bounded };
}
function unwrap<T>(result: StudioResult<T>): T {
  if (!result.ok) throw new ToolFailure(result.error);
  return result.value;
}
function studio() {
  if (typeof window === "undefined" || !window.subtitleStudio) throw new ToolFailure("subtitle_studio_unavailable");
  return window.subtitleStudio;
}
function context(signal?: AbortSignal): Context {
  const sessionId = useAgentStore.getState().session.id;
  return { sessionId, signal, check() {
    if (signal?.aborted) throw new ToolFailure("agent_cancelled");
    if (sessionId !== useAgentStore.getState().session.id) throw new ToolFailure("agent_session_changed");
  } };
}
export async function run<S extends z.ZodType>(schema: S, input: unknown, options: { abortSignal?: AbortSignal } | undefined,
  execute: (args: z.output<S>, ctx: Context) => Promise<PreparedActionResult>): Promise<PreparedActionResult> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return failed("invalid_tool_arguments");
  const ctx = context(options?.abortSignal);
  try { ctx.check(); return await execute(parsed.data, ctx); }
  catch (error) {
    if (error instanceof ToolFailure) return failed(error.message);
    if (options?.abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) return failed("agent_cancelled");
    // Keep the stable code for the UI, but retain a bounded, redacted cause for diagnosis.
    const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 600);
    if (ctx.sessionId === useAgentStore.getState().session.id) {
      useAgentStore.getState().appendLog("error", `tool_request_failed: ${reason}`, { source: "modern_tool", reason });
    }
    return failed("tool_request_failed", { reason });
  }
}
function redactSecrets(text: string): string {
  const { getAgentProfile, getTaskProfile } = useModelStore.getState();
  return [getAgentProfile()?.apiKey, getTaskProfile()?.apiKey].reduce<string>(
    (value, key) => key && key.trim() ? value.split(key).join("[redacted]") : value, text);
}
function documentSummary(document: DocumentSummary) {
  return { documentId: document.id, revision: document.revision, name: safeText(document.origin.displayName),
    format: document.origin.format, cueCount: document.cueCount, translationStatus: document.translationStatus,
    canTranslate: document.capabilities.translate,
    task: document.task ? { taskId: document.task.id, status: document.task.status, completedBatches: document.task.completedBatches, totalBatches: document.task.totalBatches } : null,
    ...(document.automaticExport ? { automaticExport: { state: document.automaticExport.state, ...(document.automaticExport.fileName ? { fileName: safeText(document.automaticExport.fileName) } : {}),
      ...(document.automaticExport.error ? { error: document.automaticExport.error } : {}) } } : {}) };
}
export async function exposePrepared(action: PreparedAction, ctx: Context, extra: Record<string, unknown> = {}): Promise<PreparedActionResult> {
  try { ctx.check(); }
  catch (error) { usePreparedActionsStore.getState().dismissAction(action.id); throw error; }
  if (useAgentStore.getState().executionMode === "auto_execute" && !action.requiresConfirmation) {
    await usePreparedActionsStore.getState().confirmAction(action.id);
    const completed = usePreparedActionsStore.getState().actions.find(item => item.id === action.id)!;
    const data = { actionId: action.id, receipt: action.preparationReceipt, result: completed.result, ...extra };
    return completed.status === "completed" ? succeeded({ ...data, executionStatus: "submitted" })
      : failed(completed.error ?? "prepared_action_not_submitted", data);
  }
  return succeeded({ ...extra, actionId: action.id, executionStatus: "prepared", title: action.title, summary: action.summary, receipt: action.preparationReceipt,
    nextAction: action.requiresConfirmation ? "The user reviews and confirms this on its card; the outcome arrives as an interface event. Nothing has been saved yet."
      : "Confirm this prepared action in HomeAgent to submit it. No task has started." });
}

export const listStudioDocumentsSchema = z.object({ ...page, query: z.string().max(200).default(""),
  format: z.enum(["all", "srt", "lrc", "vtt", "ass", "ssa", "sbv", "media"]).default("all"),
  status: z.enum(["all", "untranslated", "translated", "active", "attention"]).default("all") }).strict();
export const studioTasksSchema = z.object({ ...page, kind: z.enum(["translation", "transcription"]).default("translation") }).strict();
export const importStudioSchema = z.object({ encoding: encodingSchema.default("utf-8"),
  paths: z.array(z.string().min(3).max(4096)).min(1).max(20).optional(), recursive: z.boolean().optional() }).strict();
export const prepareStudioTranslationSchema = z.object({
  documents: z.array(z.object({ documentId: id, revision: z.number().int().positive().safe() }).strict()).min(1).max(50)
    .refine(items => new Set(items.map(item => item.documentId)).size === items.length),
  // Omitted settings follow the Studio translation dialog's latest settings in this session.
  targetLanguage: z.string().trim().min(1).max(100).optional(), instructions: z.string().max(4000).optional(),
  contextWindow: z.number().int().min(2048).max(1000000).optional(),
  maxOutputTokens: z.number().int().min(256).max(32768).optional(), maxBatchCues: z.number().int().min(1).max(100).optional(),
}).strict().refine(value => value.maxOutputTokens === undefined || value.contextWindow === undefined || value.maxOutputTokens < value.contextWindow);
/** The Studio dialog's language default: the interface language when it is a translation target, otherwise Chinese. */
const dialogLanguage = () => { const value = i18n.resolvedLanguage; return value && ["zh", "en", "ja", "zh-Hant"].includes(value) ? value : "zh"; };
const draftNumber = (value: string | undefined) => { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : undefined; };
export const prepareStudioTranscriptionSchema = z.object({ modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  language: language.optional(), devicePreference: z.enum(["auto", "cpu", "metal", "cuda"]).optional(),
  taskMode: z.enum(["transcribe", "translate_to_english"]).optional(),
  initialPrompt: z.string().max(1000).optional(),
  paths: z.array(z.string().min(3).max(4096)).min(1).max(20).optional(),
  recursive: z.boolean().optional(),
  offset: z.number().int().min(0).max(100000).optional(),
  // Each file is translated as soon as it is transcribed, then written next to its media, without the assistant.
  translation: z.object({ language: z.string().trim().min(2).max(32), instructions: z.string().max(4000).optional(),
    knowledge: z.object({ collectionIds: z.array(z.string().min(1).max(200)).max(50), recipeId: z.string().min(1).max(200).optional(),
      sourceLanguage: z.string().min(2).max(16).optional() }).strict().optional() }).strict().optional(),
  export: z.object({ format: z.enum(["auto", "srt", "lrc", "vtt", "ass", "ssa", "sbv"]).optional(), content: z.enum(["bilingual", "target", "source"]).optional(),
    order: z.enum(["source-first", "target-first"]).optional(), conflictPolicy: z.enum(["indexed", "overwrite"]).optional(),
    removeDocument: z.boolean().optional() }).strict().optional() }).strict();
export const configureLocalTranscriptionSchema = z.object({ language: language.optional(),
  modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  devicePreference: z.enum(["auto", "cpu", "metal", "cuda"]).optional(),
  outputFormats: z.array(z.enum(["SRT", "LRC"])).min(1).max(2).refine(values => new Set(values).size === values.length).optional(),
  taskMode: z.enum(["transcribe", "translate_to_english"]).optional(), initialPrompt: z.string().max(1000).optional(),
}).strict();
const emptySchema = z.object({}).strict();
const pageSchema = z.object(page).strict();

export const modernAgentTools = {
  list_agent_capabilities: tool({ description: "Discover FusionKit's seven official featured/classic tools, their routes and supported actions. Experimental tools are not included. Route links do not start tasks.",
    inputSchema: emptySchema, execute: (args, options) => run(emptySchema, args, options, async () => succeeded({ tools: AGENT_CAPABILITIES })) }),
  list_studio_documents: tool({ description: "Search the subtitle studio library. Returns documentId and revision for preparing translation, bounded metadata only. Supports imported subtitles and transcribed media documents.",
    inputSchema: listStudioDocumentsSchema, execute: (args, options) => run(listStudioDocumentsSchema, args, options, async (input, ctx) => {
      const snapshot = unwrap(await studio().listDocuments({ offset: input.offset, pageSize: input.limit, query: input.query, format: input.format, status: input.status }));
      ctx.check(); return succeeded({ total: snapshot.total, offset: input.offset, items: snapshot.documents.slice(0, input.limit).map(documentSummary), unavailableCount: snapshot.unavailableDocuments });
    }) }),
  get_studio_tasks: tool({ description: "Read actual subtitle studio translation or transcription task progress. Submitted or queued tasks are not completed work. Use pagination for bounded results.",
    inputSchema: studioTasksSchema, execute: (args, options) => run(studioTasksSchema, args, options, async (input, ctx) => {
      if (input.kind === "translation") {
        const snapshot = unwrap(await studio().listTranslationTasks({ offset: input.offset, pageSize: input.limit }));
        ctx.check(); return succeeded({ kind: input.kind, total: snapshot.total, counts: snapshot.counts, offset: input.offset,
          items: snapshot.items.slice(0, input.limit).map(item => ({ documentId: item.documentId, revision: item.revision, taskId: item.taskId,
            name: safeText(item.displayName), status: item.status, completedBatches: item.completedBatches, totalBatches: item.totalBatches, canResume: item.canResume, error: item.error })) });
      }
      const tasks = unwrap(await studio().listTranscriptionTasks({})); ctx.check();
      return succeeded({ kind: input.kind, total: tasks.length, offset: input.offset, items: tasks.slice(input.offset, input.offset + input.limit).map(item => ({
        taskId: item.taskId, batchId: item.batchId, name: safeText(item.displayName), status: item.status, progress: item.progress,
        documentId: item.documentId, automaticTranslation: item.automaticTranslation, error: item.error?.code })) });
    }) }),
  import_studio_subtitles: tool({ description: "Import subtitles into the studio. When the user typed subtitle file or folder paths, pass them exactly as typed in paths (folders give their SRT/LRC/VTT/ASS/SSA/SBV files in name order, up to 100; subfolders only with recursive=true when asked). Paths the user did not type are refused. Without paths, FusionKit's fixed native subtitle picker opens. Does not start translation.",
    inputSchema: importStudioSchema, execute: (args, options) => run(importStudioSchema, args, options, async (input, ctx) => {
      ctx.check();
      if (input.paths && !input.paths.every(item => userMentionedPath(useAgentStore.getState().session.messages, item))) throw new ToolFailure("studio_import_path_not_typed");
      const result = input.paths
        ? unwrap(await studio().importSubtitlePaths({ encoding: input.encoding, paths: input.paths, ...(input.recursive ? { recursive: true } : {}) }))
        : unwrap(await studio().importSubtitles({ encoding: input.encoding }));
      if (input.paths && result && !result.items.length) return failed("studio_import_no_subtitles");
      // Import is already committed by this fixed API; preserve its receipt if the chat stopped.
      if (!result) return succeeded({ cancelled: true, importedCount: 0 });
      return succeeded({ importedCount: result.items.filter(item => item.ok).length, total: result.items.length,
        items: result.items.slice(0, 50).map(item => item.ok ? { ok: true, document: documentSummary(item.document) } : { ok: false, name: safeText(item.fileName), error: item.error }),
        truncated: result.items.length > 50 });
    }) }),
  prepare_studio_translation: tool({ description: "Prepare translation of exact studio documentId/revision pairs from list_studio_documents. Uses the configured task model internally. Auto mode submits; other modes create an explicit HomeAgent confirmation action. Planning is not task completion.",
    inputSchema: prepareStudioTranslationSchema, execute: (args, options) => run(prepareStudioTranslationSchema, args, options, async (input, ctx) => {
      const draft = translationDraftMemory.last();
      const settings = new SettingsResolver();
      const models = useModelStore.getState();
      const draftProfile = draft?.profileId ? models.profiles.find(item => item.id === draft.profileId && item.apiKey.trim()) : undefined;
      const profile = draftProfile ?? models.getTaskProfile();
      if (!profile?.apiKey.trim()) throw new ToolFailure("task_model_not_configured");
      settings.note("model", profile.name || profile.modelKey, draftProfile ? "tool_page" : "default");
      const targetLanguage = settings.pick("targetLanguage", input.targetLanguage, draft?.language, dialogLanguage());
      const config = translationConfigSchema.safeParse({ model: normalizeTranslationModel({ profileId: profile.id, modelKey: profile.modelKey,
        endpoint: profile.baseUrl, apiFormat: profile.apiFormat, outputTokenParameter: profile.outputTokenParameter }), language: targetLanguage,
        instructions: settings.pick("instructions", input.instructions, draft?.instructions, ""),
        contextWindow: settings.pick("contextWindow", input.contextWindow, draftNumber(draft?.contextWindow), 32768),
        maxOutputTokens: settings.pick("maxOutputTokens", input.maxOutputTokens, draftNumber(draft?.maxOutputTokens), 4096),
        maxBatchCues: settings.pick("maxBatchCues", input.maxBatchCues, draftNumber(draft?.maxBatchCues), 32) });
      if (!config.success) throw new ToolFailure("task_model_configuration_invalid");
      // Ordinary batch plans have no public release operation. Main retains only
      // bounded metadata, replaces the owner's previous plan, and expires it at 15 min.
      // Retire the old card before invoking: an aborted or ambiguous new plan can
      // still replace it in main, so it must not remain confirmable in the UI.
      ctx.check();
      for (const previous of usePreparedActionsStore.getState().actions) {
        if (previous.status === "ready" && previous.summaryKey === "home:prepared_translation_summary") usePreparedActionsStore.getState().dismissAction(previous.id);
      }
      ctx.check(); const plan = unwrap(await studio().planTranslationBatch({ documents: input.documents, config: config.data })); ctx.check();
      const ready = plan.items.filter(item => item.ok);
      const preparationReceipt = receipt("preparation", plan.items.map(item => ({ id: item.documentId, name: item.displayName,
        status: item.ok ? "ready" : "failed", ...(!item.ok ? { error: item.error } : {}) })));
      if (!ready.length) return failed("studio_translation_plan_has_no_ready_documents", { receipt: preparationReceipt });
      const sessionId = ctx.sessionId;
      const fileNames = ready.slice(0, 5).map(item => safeText(item.displayName, 120)).join(", ");
      const action = registerPreparedAction({ sessionId, toolKey: "subtitleStudio", title: "Subtitle studio translation",
        preparationReceipt,
        summary: `${ready.length}/${input.documents.length} documents → ${safeText(targetLanguage, 100)}; estimated input tokens: ${plan.totalEstimatedInputTokens}. ${fileNames}`,
        summaryKey: "home:prepared_translation_summary", summaryValues: { count: ready.length, total: input.documents.length, language: targetLanguage, tokens: plan.totalEstimatedInputTokens, files: fileNames },
        execute: async () => {
          const notSubmitted = (error: string) => failed(error, { receipt: receipt("submission", preparationReceipt.items.map(item => ({
            id: item.id, name: item.name, status: "failed", error: item.error ?? error }))) });
          if (useAgentStore.getState().session.id !== sessionId) return notSubmitted("agent_session_changed");
          let response: Awaited<ReturnType<ReturnType<typeof studio>["createTranslationBatch"]>>;
          try { response = await studio().createTranslationBatch({ batchId: plan.batchId, apiKey: profile.apiKey }); }
          // A lost IPC response may follow a committed admission. No per-file outcome is known.
          catch { return failed("studio_translation_submission_unknown"); }
          if (!response.ok) return notSubmitted(response.error);
          const result = response.value;
          const taskIds = result.items.flatMap(item => item.ok ? [item.taskId] : []);
          if (taskIds.length) getStudioTranslationOverviewController().trackStarted(taskIds);
          const submissionReceipt = receipt("submission", result.items.map(item => ({ id: item.documentId,
            name: item.displayName, status: item.ok ? "queued" : "failed", ...(item.ok ? { taskId: item.taskId } : { error: item.error }) })));
          const data = { receipt: submissionReceipt, taskIds, items: result.items.map(item => item.ok
            ? { documentId: item.documentId, name: safeText(item.displayName), taskId: item.taskId, ok: true }
            : { documentId: item.documentId, name: safeText(item.displayName), ok: false, error: item.error }) };
          return taskIds.length ? succeeded({ ...data, executionStatus: "queued" }) : failed("studio_translation_not_admitted", data);
        },
      });
      return exposePrepared(action, ctx, { appliedSettings: settings.applied });
    }) }),
  prepare_studio_transcription: tool({ description: "Prepare local audio/video transcription into subtitle studio. When the user typed file or folder paths, pass them exactly as typed in paths: a folder gives its audio/video files in name order (subfolders only with recursive=true, when the user asked for them). Paths the user did not type are refused. Without paths, FusionKit's fixed native media picker opens. At most 100 files per preparation: when the result has nextOffset, prepare the next batch with the same paths and that offset after this one is confirmed. To finish the whole job without stopping, pass translation (target language such as 'zh', optional instructions and knowledge collection/recipe IDs from search_translation_knowledge) and export (format 'auto' = LRC for audio, SRT for video; content bilingual/target/source; order source-first/target-first; conflictPolicy indexed = add a number, overwrite = replace a same-name file; removeDocument = delete the Studio document after its file is written): each file is then translated as soon as it is transcribed and written next to its media, and you are told when the batch is done. Pass them only for what the user asked for, after asking what you need to know; without export, Studio's own auto-export setting applies, and export fields you leave out follow it too. Requires an installed runtime/model. Existing manual drafts must be handled first. Auto mode submits; other modes wait for confirmation.",
    inputSchema: prepareStudioTranscriptionSchema, execute: (args, options) => run(prepareStudioTranscriptionSchema, args, options, async (input, ctx) => {
      studio(); const controller = getStudioTranscriptionController();
      await controller.refresh(); ctx.check();
      const before = controller.getState();
      if (before.drafts.length || before.selecting || before.submitting) throw new ToolFailure("studio_transcription_existing_drafts");
      const config = { ...before.config, ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.language ? { language: input.language } : {}),
        ...(input.devicePreference ? { devicePreference: input.devicePreference } : {}),
        // Omitted task mode and prompt keep the Studio transcription settings.
        ...(input.taskMode ? { taskMode: input.taskMode } : {}),
        advanced: { ...before.config.advanced, ...(input.initialPrompt !== undefined ? { initialPrompt: input.initialPrompt } : {}) } };
      const parsedConfig = transcriptionTaskConfigSchema.safeParse(config);
      if (!parsedConfig.success) throw new ToolFailure("studio_transcription_configuration_invalid");
      ctx.check(); controller.setConfig(parsedConfig.data);
      // Translation for this batch only: the user's saved Studio choice comes back once it is submitted or dropped.
      const savedAutomatic = before.autoTranslation;
      const restoreAutomatic = () => controller.setAutoTranslation(savedAutomatic);
      // Like every setting the user did not name, export follows the Studio page: its switch when export is not
      // mentioned, its choices for anything a requested export leaves open.
      const pageExport = before.autoExport;
      const exportSpec: AutomaticExportSpec | undefined = input.export ? { format: input.export.format ?? pageExport.format,
        mode: input.export.content ?? (input.translation ? pageExport.mode : "source"), order: input.export.order ?? pageExport.order,
        conflictPolicy: input.export.conflictPolicy ?? pageExport.conflictPolicy, removeAfterExport: input.export.removeDocument ?? !!pageExport.removeAfterExport }
        : automaticExportFromPreferences(pageExport, !!input.translation);
      const exportSource = input.export ? "user" : exportSpec ? "tool_page" : null;
      if (exportSpec && exportSpec.mode !== "source" && !input.translation) throw new ToolFailure("studio_export_needs_translation");
      ctx.check();
      controller.setAutoTranslation(input.translation
        ? { ...before.autoTranslation, enabled: true, language: input.translation.language, instructions: input.translation.instructions ?? before.autoTranslation.instructions,
          ...(before.autoTranslation.knowledge ? { knowledge: { ...before.autoTranslation.knowledge, enabled: false } } : {}) }
        : { ...before.autoTranslation, enabled: false });
      if (input.translation?.knowledge) {
        const library = await controller.refreshAutomaticKnowledge(); ctx.check();
        const accepted = !!library && controller.setAutomaticKnowledge({ enabled: true, collectionIds: input.translation.knowledge.collectionIds,
          disabledEntryIds: [], documentTopicIds: [], ...(input.translation.knowledge.recipeId ? { recipeId: input.translation.knowledge.recipeId } : {}),
          sourceLanguage: (input.translation.knowledge.sourceLanguage ?? (parsedConfig.data.language === "auto" ? "" : parsedConfig.data.language)) as never }, library.generation);
        if (!accepted) { restoreAutomatic(); throw new ToolFailure("studio_translation_knowledge_invalid"); }
      }
      ctx.check();
      let page: { matched: number; nextOffset?: number } | undefined;
      if (input.paths) {
        // A typed path is the user's own choice of input, like a picker selection; anything else is not.
        const messages = useAgentStore.getState().session.messages;
        if (!input.paths.every(item => userMentionedPath(messages, item))) throw new ToolFailure("studio_transcription_path_not_typed");
        page = await controller.selectMediaFromPaths({ paths: input.paths, ...(input.recursive ? { recursive: true } : {}), ...(input.offset ? { offset: input.offset } : {}) });
        ctx.check();
        if (page && page.matched === 0) return failed("studio_transcription_no_media");
      } else await controller.selectMedia();
      const pathPage = page ? { mediaMatched: page.matched, ...(page.nextOffset !== undefined ? { nextOffset: page.nextOffset } : {}) } : {};
      const selected = controller.getState();
      const ownedIds = selected.drafts.map(item => item.id);
      const release = () => {
        for (const draft of controller.getState().drafts) if (ownedIds.includes(draft.id) && !["submitting", "submission_unknown"].includes(draft.status)) controller.removeDraft(draft.id);
        restoreAutomatic();
      };
      try {
        ctx.check();
        if (!ownedIds.length) return selected.error ? failed(selected.error) : succeeded({ cancelled: true });
        const readiness = getTranscriptionReadiness(selected);
        // Draft IDs are native file capabilities. Use display-only row references in receipts.
        const preparationReceipt = receipt("preparation", selected.drafts.map((draft, index) => ({ id: `media-${index + 1}`,
          name: draft.displayName, status: draft.status === "ready" && !readiness.reason ? "ready" : "failed",
          ...(draft.status !== "ready" || readiness.reason ? { error: draft.error ?? readiness.reason ?? "studio_transcription_media_not_ready" } : {}) })));
        if (!readiness.canEnqueue || readiness.readyCount !== ownedIds.length) {
          release(); return failed(readiness.reason ?? "studio_transcription_media_not_ready", { receipt: preparationReceipt });
        }
        const signature = JSON.stringify({ config: selected.config, automatic: selected.autoTranslation, drafts: selected.drafts.map(item => ({ id: item.id, stream: item.audioStreamId })) });
        const sessionId = ctx.sessionId;
        const fileNames = selected.drafts.slice(0, 5).map(item => safeText(item.displayName, 120)).join(", ");
        const action = registerPreparedAction({ sessionId, toolKey: "subtitleStudio", title: "Subtitle studio transcription",
          preparationReceipt,
          summary: `${ownedIds.length} media files; ${safeText(selected.config.modelId, 128)}; ${selected.config.language}. ${fileNames}`, cleanup: release,
          summaryKey: "home:prepared_transcription_summary", summaryValues: { count: ownedIds.length, model: selected.config.modelId, language: selected.config.language, files: fileNames,
            ...(input.translation ? { translateTo: input.translation.language } : {}),
            ...(exportSpec ? { exportFormat: exportSpec.format, exportContent: exportSpec.mode, exportConflict: exportSpec.conflictPolicy, exportRemove: exportSpec.removeAfterExport ? 1 : 0 } : {}) },
          execute: async () => {
            const notAdmitted = (error: string) => failed(error, { receipt: receipt("submission", preparationReceipt.items.map((item, index) => ({
              id: item.id, name: item.name, status: "failed",
              error: controller.getState().drafts.find(current => current.id === ownedIds[index])?.error ?? error }))) });
            if (useAgentStore.getState().session.id !== sessionId) return notAdmitted("agent_session_changed");
            const current = controller.getState();
            if (signature !== JSON.stringify({ config: current.config, automatic: current.autoTranslation, drafts: current.drafts.map(item => ({ id: item.id, stream: item.audioStreamId })) })) return notAdmitted("studio_transcription_draft_changed");
            const currentReadiness = getTranscriptionReadiness(current);
            if (!currentReadiness.canEnqueue || currentReadiness.readyCount !== ownedIds.length) return notAdmitted("studio_transcription_not_ready");
            const admission = await controller.enqueue({ expectedDraftIds: ownedIds, autoExport: exportSpec ?? null });
            restoreAutomatic();
            if (admission && (input.translation || exportSpec)) watchStudioPipeline({ sessionId, taskIds: admission.tasks.map(item => item.taskId),
              translate: !!input.translation, exportFiles: !!exportSpec, removeAfterExport: !!exportSpec?.removeAfterExport });
            if (!admission) {
              if (controller.getState().drafts.some(item => item.status === "submission_unknown")) return failed("studio_transcription_submission_unknown");
              return notAdmitted(controller.getState().error ?? "studio_transcription_not_admitted");
            }
            return succeeded({ executionStatus: "queued", batchId: admission.batchId,
              receipt: receipt("submission", admission.tasks.map(item => ({ id: item.taskId, name: item.displayName, taskId: item.taskId, status: "queued" }))),
              tasks: admission.tasks.map(item => ({ taskId: item.taskId, name: safeText(item.displayName), status: item.status })),
              ...(input.translation || exportSpec ? { pipeline: { translateTo: input.translation?.language ?? null, export: exportSpec ?? null, exportSettingsFrom: exportSource,
                note: "Runs per file without you; you will get an interface event when the whole batch is done." } } : {}) });
          },
        });
        return await exposePrepared(action, ctx, { ...pathPage, ...(input.translation || exportSpec ? { pipeline: { translateTo: input.translation?.language ?? null, export: exportSpec ?? null, exportSettingsFrom: exportSource } } : {}) });
      } catch (error) { release(); throw error; }
    }) }),
  get_local_transcription_status: tool({ description: "Read classic local subtitle transcriber runtime/resources and existing tasks. Does not install resources, start transcription or expose paths/file capabilities.",
    inputSchema: pageSchema, execute: (args, options) => run(pageSchema, args, options, async (input, ctx) => {
      if (typeof window === "undefined" || !window.localSubtitleApi) throw new ToolFailure("local_transcription_unavailable");
      const [runtime, resources, snapshot] = await Promise.all([window.localSubtitleApi.probeRuntime(), window.localSubtitleApi.listManagedResources(), window.localSubtitleApi.getSessionSnapshot()]);
      ctx.check(); const tasks = snapshot.ok ? snapshot.data.batches.flatMap(batch => batch.tasks) : [];
      if (!runtime.ok && !resources.ok && !snapshot.ok) return failed(snapshot.error.code);
      return succeeded({ runtime: runtime.ok ? { platform: runtime.data.platform, arch: runtime.data.arch, runner: runtime.data.runner.status, mediaRuntime: runtime.data.mediaRuntime.status } : { error: runtime.error.code },
        resources: resources.ok ? resources.data.slice(0, 50).map(item => ({ id: item.resourceId, name: safeText(item.displayName), kind: item.resourceType, status: item.status })) : { error: resources.error.code },
        taskReadError: snapshot.ok ? undefined : snapshot.error.code, total: tasks.length, offset: input.offset,
        tasks: tasks.slice(input.offset, input.offset + input.limit).map(item => ({ taskId: item.taskId, batchId: item.batchId, name: safeText(item.displayName), status: item.status, progress: item.progress, error: item.error?.code })) });
    }) }),
  configure_local_transcription: tool({ description: "Set safe preferences for the classic local subtitle transcriber and return its page link. The user must choose real media files on that page; this handoff does not queue or start transcription.",
    inputSchema: configureLocalTranscriptionSchema, execute: (args, options) => run(configureLocalTranscriptionSchema, args, options, async (input, ctx) => {
      ctx.check(); const { taskMode, initialPrompt, ...preferences } = input;
      const store = useLocalSubtitleTranscriberStore.getState();
      if (Object.keys(preferences).length) store.updatePreferences(preferences);
      ctx.check(); if (taskMode !== undefined) store.setDraftTaskMode(taskMode);
      ctx.check(); if (initialPrompt !== undefined) store.setDraftInitialPrompt(initialPrompt);
      return succeeded({ executionStatus: "configured", route: AGENT_CAPABILITIES.find(item => item.toolKey === "localSubtitleTranscriber")!.route,
        nextAction: "Open the local subtitle transcriber, select media files, review settings, then start there. No task has started." });
    }) }),
};
