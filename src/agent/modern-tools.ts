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
import { entrySummary } from "@/translation-knowledge/ipc-contract";
import { AGENT_CAPABILITIES } from "./capability-catalog";
import { registerPreparedAction, usePreparedActionsStore, type PreparedAction, type PreparedActionReceipt, type PreparedActionResult } from "./prepared-actions";

interface Context { sessionId: string; signal?: AbortSignal; check: () => void }
const page = { offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(50).default(20) };
const id = z.string().uuid();
const language = z.string().trim().min(2).max(32).regex(/^(?:auto|[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/);
const safeText = (value: string, length = 255) => value.slice(0, length);
class ToolFailure extends Error {}
const failed = (error: string, data?: unknown): PreparedActionResult => ({ success: false, error, ...(data !== undefined ? { data } : {}) });
const succeeded = (data: unknown): PreparedActionResult => ({ success: true, data });
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
async function run<S extends z.ZodType>(schema: S, input: unknown, options: { abortSignal?: AbortSignal } | undefined,
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
    task: document.task ? { taskId: document.task.id, status: document.task.status, completedBatches: document.task.completedBatches, totalBatches: document.task.totalBatches } : null };
}
async function exposePrepared(action: PreparedAction, ctx: Context): Promise<PreparedActionResult> {
  try { ctx.check(); }
  catch (error) { usePreparedActionsStore.getState().dismissAction(action.id); throw error; }
  if (useAgentStore.getState().executionMode === "auto_execute") {
    await usePreparedActionsStore.getState().confirmAction(action.id);
    const completed = usePreparedActionsStore.getState().actions.find(item => item.id === action.id)!;
    const data = { actionId: action.id, receipt: action.preparationReceipt, result: completed.result };
    return completed.status === "completed" ? succeeded({ ...data, executionStatus: "submitted" })
      : failed(completed.error ?? "prepared_action_not_submitted", data);
  }
  return succeeded({ actionId: action.id, executionStatus: "prepared", title: action.title, summary: action.summary, receipt: action.preparationReceipt,
    nextAction: "Confirm this prepared action in HomeAgent to submit it. No task has started." });
}

export const listStudioDocumentsSchema = z.object({ ...page, query: z.string().max(200).default(""),
  format: z.enum(["all", "srt", "lrc", "vtt", "ass", "ssa", "sbv", "media"]).default("all"),
  status: z.enum(["all", "untranslated", "translated", "active", "attention"]).default("all") }).strict();
export const studioTasksSchema = z.object({ ...page, kind: z.enum(["translation", "transcription"]).default("translation") }).strict();
export const importStudioSchema = z.object({ encoding: encodingSchema.default("utf-8") }).strict();
export const prepareStudioTranslationSchema = z.object({
  documents: z.array(z.object({ documentId: id, revision: z.number().int().positive().safe() }).strict()).min(1).max(50)
    .refine(items => new Set(items.map(item => item.documentId)).size === items.length),
  targetLanguage: z.string().trim().min(1).max(100).default("zh"), instructions: z.string().max(4000).default(""),
  contextWindow: z.number().int().min(2048).max(1000000).default(32768),
  maxOutputTokens: z.number().int().min(256).max(32768).default(4096), maxBatchCues: z.number().int().min(1).max(100).default(32),
}).strict().refine(value => value.maxOutputTokens < value.contextWindow);
export const prepareStudioTranscriptionSchema = z.object({ modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  language: language.optional(), devicePreference: z.enum(["auto", "cpu", "metal", "cuda"]).optional(),
  taskMode: z.enum(["transcribe", "translate_to_english"]).default("transcribe"),
  initialPrompt: z.string().max(1000).default("") }).strict();
export const configureLocalTranscriptionSchema = z.object({ language: language.optional(),
  modelId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional(),
  devicePreference: z.enum(["auto", "cpu", "metal", "cuda"]).optional(),
  outputFormats: z.array(z.enum(["SRT", "LRC"])).min(1).max(2).refine(values => new Set(values).size === values.length).optional(),
  taskMode: z.enum(["transcribe", "translate_to_english"]).optional(), initialPrompt: z.string().max(1000).optional(),
}).strict();
export const knowledgeSearchSchema = z.object({ ...page, query: z.string().max(200).default(""),
  collectionId: id.optional(), kind: z.enum(["all", "term", "context", "expression", "memory", "rule"]).default("all"),
  includeArchived: z.boolean().default(false) }).strict();
const emptySchema = z.object({}).strict();
const pageSchema = z.object(page).strict();

export const modernAgentTools = {
  list_agent_capabilities: tool({ description: "Discover FusionKit's six official featured/classic tools, their routes and supported actions. Experimental tools are not included. Route links do not start tasks.",
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
  import_studio_subtitles: tool({ description: "Open FusionKit's fixed native subtitle picker and import selected subtitles into the studio. Does not start translation. The user selects files; never provide raw paths or capabilities.",
    inputSchema: importStudioSchema, execute: (args, options) => run(importStudioSchema, args, options, async (input, ctx) => {
      ctx.check(); const result = unwrap(await studio().importSubtitles(input));
      // Import is already committed by this fixed API; preserve its receipt if the chat stopped.
      if (!result) return succeeded({ cancelled: true, importedCount: 0 });
      return succeeded({ importedCount: result.items.filter(item => item.ok).length, total: result.items.length,
        items: result.items.slice(0, 50).map(item => item.ok ? { ok: true, document: documentSummary(item.document) } : { ok: false, name: safeText(item.fileName), error: item.error }),
        truncated: result.items.length > 50 });
    }) }),
  prepare_studio_translation: tool({ description: "Prepare translation of exact studio documentId/revision pairs from list_studio_documents. Uses the configured task model internally. Auto mode submits; other modes create an explicit HomeAgent confirmation action. Planning is not task completion.",
    inputSchema: prepareStudioTranslationSchema, execute: (args, options) => run(prepareStudioTranslationSchema, args, options, async (input, ctx) => {
      const profile = useModelStore.getState().getTaskProfile();
      if (!profile?.apiKey.trim()) throw new ToolFailure("task_model_not_configured");
      const config = translationConfigSchema.safeParse({ model: normalizeTranslationModel({ profileId: profile.id, modelKey: profile.modelKey,
        endpoint: profile.baseUrl, apiFormat: profile.apiFormat, outputTokenParameter: profile.outputTokenParameter }), language: input.targetLanguage,
        instructions: input.instructions, contextWindow: input.contextWindow, maxOutputTokens: input.maxOutputTokens, maxBatchCues: input.maxBatchCues });
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
        summary: `${ready.length}/${input.documents.length} documents → ${safeText(input.targetLanguage, 100)}; estimated input tokens: ${plan.totalEstimatedInputTokens}. ${fileNames}`,
        summaryKey: "home:prepared_translation_summary", summaryValues: { count: ready.length, total: input.documents.length, language: input.targetLanguage, tokens: plan.totalEstimatedInputTokens, files: fileNames },
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
      return exposePrepared(action, ctx);
    }) }),
  prepare_studio_transcription: tool({ description: "Prepare local audio/video transcription into subtitle studio with a fixed native media picker. Requires an installed runtime/model. Existing manual drafts must be handled first. Auto mode submits; other modes wait for confirmation. Does not silently enable automatic translation.",
    inputSchema: prepareStudioTranscriptionSchema, execute: (args, options) => run(prepareStudioTranscriptionSchema, args, options, async (input, ctx) => {
      studio(); const controller = getStudioTranscriptionController();
      await controller.refresh(); ctx.check();
      const before = controller.getState();
      if (before.drafts.length || before.selecting || before.submitting) throw new ToolFailure("studio_transcription_existing_drafts");
      const config = { ...before.config, ...(input.modelId ? { modelId: input.modelId } : {}), ...(input.language ? { language: input.language } : {}),
        ...(input.devicePreference ? { devicePreference: input.devicePreference } : {}), taskMode: input.taskMode,
        advanced: { ...before.config.advanced, initialPrompt: input.initialPrompt } };
      const parsedConfig = transcriptionTaskConfigSchema.safeParse(config);
      if (!parsedConfig.success) throw new ToolFailure("studio_transcription_configuration_invalid");
      ctx.check(); controller.setConfig(parsedConfig.data);
      ctx.check(); controller.setAutoTranslation({ ...before.autoTranslation, enabled: false });
      ctx.check(); await controller.selectMedia();
      const selected = controller.getState();
      const ownedIds = selected.drafts.map(item => item.id);
      const release = () => { for (const draft of controller.getState().drafts) if (ownedIds.includes(draft.id) && !["submitting", "submission_unknown"].includes(draft.status)) controller.removeDraft(draft.id); };
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
          summaryKey: "home:prepared_transcription_summary", summaryValues: { count: ownedIds.length, model: selected.config.modelId, language: selected.config.language, files: fileNames },
          execute: async () => {
            const notAdmitted = (error: string) => failed(error, { receipt: receipt("submission", preparationReceipt.items.map((item, index) => ({
              id: item.id, name: item.name, status: "failed",
              error: controller.getState().drafts.find(current => current.id === ownedIds[index])?.error ?? error }))) });
            if (useAgentStore.getState().session.id !== sessionId) return notAdmitted("agent_session_changed");
            const current = controller.getState();
            if (signature !== JSON.stringify({ config: current.config, automatic: current.autoTranslation, drafts: current.drafts.map(item => ({ id: item.id, stream: item.audioStreamId })) })) return notAdmitted("studio_transcription_draft_changed");
            const currentReadiness = getTranscriptionReadiness(current);
            if (!currentReadiness.canEnqueue || currentReadiness.readyCount !== ownedIds.length) return notAdmitted("studio_transcription_not_ready");
            const admission = await controller.enqueue({ expectedDraftIds: ownedIds });
            if (!admission) {
              if (controller.getState().drafts.some(item => item.status === "submission_unknown")) return failed("studio_transcription_submission_unknown");
              return notAdmitted(controller.getState().error ?? "studio_transcription_not_admitted");
            }
            return succeeded({ executionStatus: "queued", batchId: admission.batchId,
              receipt: receipt("submission", admission.tasks.map(item => ({ id: item.taskId, name: item.displayName, taskId: item.taskId, status: "queued" }))),
              tasks: admission.tasks.map(item => ({ taskId: item.taskId, name: safeText(item.displayName), status: item.status })) });
          },
        });
        return await exposePrepared(action, ctx);
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
  search_translation_knowledge: tool({ description: "Search translation knowledge with bounded entry summaries, collection/recipe metadata and review state. Does not send the whole library, raw evidence, adopt entries or change records.",
    inputSchema: knowledgeSearchSchema, execute: (args, options) => run(knowledgeSearchSchema, args, options, async (input, ctx) => {
      if (typeof window === "undefined" || !window.translationKnowledge) throw new ToolFailure("translation_knowledge_unavailable");
      const response = await window.translationKnowledge.read(); ctx.check();
      if (!response.ok) throw new ToolFailure(response.error);
      const library = response.value;
      const query = input.query.trim().normalize("NFC").toLocaleLowerCase();
      const matches = (text: string) => text.normalize("NFC").toLocaleLowerCase().includes(query);
      const entries = library.data.entries.filter(item => (input.includeArchived || item.state !== "archived")
        && (!input.collectionId || item.collectionId === input.collectionId) && (input.kind === "all" || item.kind === input.kind)
        && matches(`${item.title} ${entrySummary(item)}`));
      const collections = library.data.collections.filter(item => (input.includeArchived || !item.archived) && matches(item.name));
      const recipes = library.data.recipes.filter(item => (input.includeArchived || !item.archived) && matches(item.name));
      const pagination = (total: number) => ({ total, hasMore: input.offset + input.limit < total,
        nextOffset: input.offset + input.limit < total ? input.offset + input.limit : null });
      return succeeded({ generation: library.generation, counts: { entries: library.data.entries.length, collections: library.data.collections.length, recipes: library.data.recipes.length },
        pagination: { offset: input.offset, limit: input.limit, entries: pagination(entries.length), collections: pagination(collections.length), recipes: pagination(recipes.length) },
        total: entries.length, offset: input.offset, entries: entries.slice(input.offset, input.offset + input.limit).map(item => ({ id: item.id, revision: item.revision,
          kind: item.kind, title: safeText(item.title), collectionId: item.collectionId, languagePair: { source: safeText(item.scope.languagePair.source, 32), target: safeText(item.scope.languagePair.target, 32) },
          state: item.state === "ready" && library.approvals[item.id]?.revision !== item.revision ? "unconfirmed" : item.state, summary: safeText(entrySummary(item), 400) })),
        collections: collections.slice(input.offset, input.offset + input.limit).map(item => ({ id: item.id, name: safeText(item.name) })),
        recipes: recipes.slice(input.offset, input.offset + input.limit).map(item => ({ id: item.id, name: safeText(item.name), languagePair: { source: safeText(item.languagePair.source, 32), target: safeText(item.languagePair.target, 32) } })) });
    }) }),
};
