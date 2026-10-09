import { z } from "zod";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useSubtitleTranslatorConfigStore from "@/store/tools/subtitle/useSubtitleTranslatorConfigStore";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useSubtitleExtractorStore from "@/store/tools/subtitle/useSubtitleExtractorStore";
import useLocalSubtitleTranscriberStore from "@/store/tools/subtitle/useLocalSubtitleTranscriberStore";
import useNameTranslatorConfigStore from "@/store/tools/rename/nameTranslatorConfig";
import useNameTranslatorStore from "@/store/tools/rename/useNameTranslatorStore";
import { getLocalSubtitleEnvironmentService } from "@/services/local-subtitle/localSubtitleEnvironmentService";
import { getLocalSubtitleRuntimeService } from "@/services/local-subtitle/localSubtitleRuntimeService";
import { LOCAL_SUBTITLE_TRANSCRIBER_ROUTE } from "@/constants/router";
import type { SubtitleConvertFormat } from "@/type/subtitle";
import type { AgentPageContext, PageTool, PageToolSet } from "./page-context";
import { converterPageSettings, extractorPageSettings, nameTranslatorPageSettings, TRANSLATION_LANGUAGES, translatorPageSettings } from "./tool-page-settings";

const SAMPLE_TASKS = 10;
const name = (value: unknown) => typeof value === "string" ? value.slice(0, 255) : "";
type TaskLike = { fileName?: string; displayName?: string; progress?: unknown };
/** Task counts by status and the first few tasks, in queue order. */
function queue(groups: Record<string, readonly TaskLike[]>) {
  const counts = Object.fromEntries(Object.entries(groups).map(([status, tasks]) => [status, tasks.length]));
  const tasks = Object.entries(groups).flatMap(([status, items]) => items.map((task) => ({ name: name(task.fileName ?? task.displayName), status,
    ...(typeof task.progress === "number" ? { progress: Math.round(task.progress) } : {}) }))).slice(0, SAMPLE_TASKS);
  return { counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), tasks };
}

type Result = { success: boolean; data?: unknown; error?: string };
/** A page tool that changes only the page's own settings and reports what changed. */
function settingsTool<S extends z.ZodTypeAny>(description: string, schema: S, read: () => Record<string, unknown>, write: (patch: z.output<S>) => void): PageTool {
  return {
    description: `${description} Changes only settings shown on this page; it starts no task. Returns the values before and after.`,
    inputSchema: schema,
    execute: async (input: unknown): Promise<Result> => {
      const parsed = schema.safeParse(input);
      if (!parsed.success) return { success: false, error: "invalid_tool_arguments" };
      const patch = parsed.data as Record<string, unknown>;
      if (!Object.keys(patch).length) return { success: false, error: "invalid_tool_arguments" };
      const before = read();
      write(parsed.data);
      const after = read();
      const changed = Object.fromEntries(Object.keys(patch).map((key) => [key, { before: before[key], after: after[key] }]));
      return { success: true, data: { changed } };
    },
  };
}

const language = z.enum(TRANSLATION_LANGUAGES);
const conflictPolicy = z.enum(["index", "overwrite"]);

const translatorSettingsSchema = z.object({
  sourceLang: language.optional(), targetLang: language.optional(),
  translationOutputMode: z.enum(["bilingual", "target_only"]).optional(),
  sliceType: z.enum(["NORMAL", "SENSITIVE", "CUSTOM"]).optional(), customSliceLength: z.number().int().min(100).max(2000).optional(),
  conflictPolicy: conflictPolicy.optional(), concurrentSlices: z.boolean().optional(), thinkingEnabled: z.boolean().optional(),
}).strict();
const converterSettingsSchema = z.object({
  toFormat: z.enum(["LRC", "SRT", "VTT", "ASS", "SSA", "SBV"]).optional(), conflictPolicy: conflictPolicy.optional(),
  stripMediaExt: z.boolean().optional(), defaultDurationSec: z.number().min(0.1).max(60).optional(),
}).strict();
const extractorSettingsSchema = z.object({ keep: language.optional(), conflictPolicy: conflictPolicy.optional() }).strict();
const nameLanguage = z.enum(["ZH", "ZH_HANT", "JA", "EN", "KO", "FR", "DE", "ES", "RU", "PT"]);
const nameSettingsSchema = z.object({
  sourceLang: z.union([z.literal("auto"), nameLanguage]).optional(), targetLang: nameLanguage.optional(),
  nameMode: z.enum(["translated", "bilingual", "custom"]).optional(),
  bilingualOrder: z.enum(["translated_first", "original_first"]).optional(),
  bilingualStyle: z.enum(["paren", "bracket", "dash", "underscore", "space"]).optional(),
  customTemplate: z.string().trim().min(1).max(200).refine((value) => value.includes("{translated}"), "Must contain {translated}").optional(),
  includeHidden: z.boolean().optional(), instructions: z.string().max(1000).optional(),
}).strict();

const suggestions = (page: string) => [
  { labelKey: `home:dock.suggest.${page}.first`, promptKey: `home:dock.suggest.${page}.first_prompt` },
  { labelKey: `home:dock.suggest.${page}.second`, promptKey: `home:dock.suggest.${page}.second_prompt` },
];

function translatorContext(): AgentPageContext {
  const tools: PageToolSet = {
    subtitle_translator_update_settings: settingsTool("Update the subtitle translator page's settings (languages, output content, slicing, conflict policy, concurrency, thinking).",
      translatorSettingsSchema, () => ({ ...useSubtitleTranslatorConfigStore.getState().preferences }), (patch) => useSubtitleTranslatorConfigStore.getState().updatePreferences(patch as never)),
  };
  return {
    route: "/tools/subtitle/translator", titleKey: "tools:fields.subtitle_translator", suggestions: suggestions("translator"), tools,
    instructions: "Subtitle translator page. queue_subtitle_translate adds tasks here with this page's settings for anything the user did not specify. Use subtitle_translator_update_settings when the user wants to change what the page uses. The user starts queued tasks with the page's Start button unless the execution mode starts them.",
    describe: () => {
      const state = useSubtitleTranslatorStore.getState();
      const settings = translatorPageSettings();
      return { settings: { ...settings, outputMode: settings.outputMode }, queue: queue({ notStarted: state.notStartedTaskQueue, waiting: state.waitingTaskQueue,
        running: state.pendingTaskQueue, completed: state.resolvedTaskQueue, failed: state.failedTaskQueue }) };
    },
  };
}

function converterContext(): AgentPageContext {
  const tools: PageToolSet = {
    subtitle_converter_update_settings: settingsTool("Update the subtitle converter page's settings (target format, conflict policy, media extension stripping, default cue duration).",
      converterSettingsSchema, () => { const state = useSubtitleConverterStore.getState(); return { toFormat: state.toFormat, conflictPolicy: state.conflictPolicy, stripMediaExt: state.stripMediaExt, defaultDurationSec: state.defaultDurationSec }; },
      (patch) => {
        const store = useSubtitleConverterStore.getState();
        if (patch.toFormat) store.setToFormat(patch.toFormat as SubtitleConvertFormat);
        if (patch.conflictPolicy) store.setConflictPolicy(patch.conflictPolicy);
        if (patch.stripMediaExt !== undefined) store.setStripMediaExt(patch.stripMediaExt);
        if (patch.defaultDurationSec !== undefined) store.setDefaultDurationSec(String(patch.defaultDurationSec));
      }),
  };
  return {
    route: "/tools/subtitle/converter", titleKey: "tools:fields.subtitle_formatter", suggestions: suggestions("converter"), tools,
    instructions: "Subtitle format converter page. scan_subtitle_files then queue_subtitle_convert add tasks here; omitted settings (target format, output folder, conflict policy) follow this page. Use subtitle_converter_update_settings to change the page's settings.",
    describe: () => {
      const state = useSubtitleConverterStore.getState();
      const page = converterPageSettings();
      return { settings: { toFormat: page.to, conflictPolicy: page.conflictPolicy, outputMode: page.outputMode, outputFolderChosen: !!page.outputDir, stripMediaExt: state.stripMediaExt, defaultDurationSec: state.defaultDurationSec },
        queue: queue({ notStarted: state.notStartedTasks, running: state.pendingTasks, completed: state.resolvedTasks, failed: state.failedTasks }) };
    },
  };
}

function extractorContext(): AgentPageContext {
  const tools: PageToolSet = {
    subtitle_extractor_update_settings: settingsTool("Update the subtitle language extractor page's settings (language to keep, conflict policy).",
      extractorSettingsSchema, () => { const state = useSubtitleExtractorStore.getState(); return { keep: state.keep, conflictPolicy: state.conflictPolicy }; },
      (patch) => {
        const store = useSubtitleExtractorStore.getState();
        if (patch.keep) store.setKeep(patch.keep as never);
        if (patch.conflictPolicy) store.setConflictPolicy(patch.conflictPolicy);
      }),
  };
  return {
    route: "/tools/subtitle/extractor", titleKey: "tools:fields.subtitle_language_extractor", suggestions: suggestions("extractor"), tools,
    instructions: "Subtitle language extractor page: keeps one language of bilingual subtitles. scan_subtitle_files then queue_subtitle_extract add tasks here; omitted settings follow this page. Use subtitle_extractor_update_settings to change the page's settings.",
    describe: () => {
      const state = useSubtitleExtractorStore.getState();
      const page = extractorPageSettings();
      return { settings: { keep: page.keep, conflictPolicy: page.conflictPolicy, outputMode: page.outputMode, outputFolderChosen: !!page.outputDir },
        queue: queue({ notStarted: state.notStartedTasks, running: state.pendingTasks, completed: state.resolvedTasks, failed: state.failedTasks }) };
    },
  };
}

function transcriberContext(): AgentPageContext {
  return {
    route: LOCAL_SUBTITLE_TRANSCRIBER_ROUTE, titleKey: "tools:fields.local_subtitle_transcriber", suggestions: suggestions("transcriber"),
    instructions: "Local subtitle transcriber page. The user picks media files on this page. get_local_transcription_status reads the environment and tasks; configure_local_transcription changes this page's settings. Starting transcription happens on the page.",
    describe: () => {
      const store = useLocalSubtitleTranscriberStore.getState();
      const environment = getLocalSubtitleEnvironmentService().getState();
      const runtime = getLocalSubtitleRuntimeService().getState();
      const { preferences } = store;
      const tasks = runtime.batches.flatMap((batch) => batch.tasks);
      const byStatus: Record<string, TaskLike[]> = {};
      for (const task of tasks) (byStatus[task.status] ??= []).push({ displayName: task.displayName });
      return {
        settings: { modelId: preferences.modelId, devicePreference: preferences.devicePreference, language: preferences.language, vadEnabled: preferences.vadEnabled,
          outputFormats: preferences.outputFormats, outputMode: preferences.outputMode, taskMode: store.draftTaskMode, initialPrompt: store.draftInitialPrompt.slice(0, 300), conflictPolicy: store.draftConflictPolicy },
        draft: { files: store.draftInputFiles.length, names: store.draftInputFiles.slice(0, SAMPLE_TASKS).map((file) => name(file.displayName)), outputFolderChosen: !!store.draftOutputDirectory },
        environment: { runtimeReady: !!environment.runtime && !environment.error, loading: environment.loading,
          readyModels: environment.resources.filter((item) => item.resourceType === "model" && item.status === "ready").map((item) => item.displayName).slice(0, 10) },
        tasks: queue(byStatus),
      };
    },
  };
}

function nameTranslatorContext(): AgentPageContext {
  const tools: PageToolSet = {
    name_translator_update_settings: settingsTool("Update the name translator page's settings (languages, name format and bracket style, custom template, hidden files, requirements).",
      nameSettingsSchema, () => ({ ...useNameTranslatorConfigStore.getState().config }), (patch) => useNameTranslatorConfigStore.getState().updateConfig(patch as never)),
  };
  return {
    route: "/tools/rename/name-translator", titleKey: "tools:fields.name_translator", suggestions: suggestions("names"), tools,
    instructions: "File and folder name translator page. create_name_translation_plan previews renames with this page's settings for anything the user did not specify; applying needs the user's later confirmation. Use name_translator_update_settings to change the page's settings.",
    describe: () => {
      const workspace = useNameTranslatorStore.getState();
      const checked = Object.values(workspace.checked ?? {}).filter(Boolean).length;
      return { settings: nameTranslatorPageSettings(),
        workspace: { roots: workspace.roots.length, entries: Object.keys(workspace.entries ?? {}).length, checked, proposals: Object.keys(workspace.proposals ?? {}).length } };
    },
  };
}

const CLASSIC_PAGES: Record<string, () => AgentPageContext> = {
  "/tools/subtitle/translator": translatorContext,
  "/tools/subtitle/converter": converterContext,
  "/tools/subtitle/extractor": extractorContext,
  [LOCAL_SUBTITLE_TRANSCRIBER_ROUTE]: transcriberContext,
  "/tools/rename/name-translator": nameTranslatorContext,
};

/** The page context of a classic tool route, or null for other routes. */
export function classicPageContext(pathname: string): AgentPageContext | null {
  return CLASSIC_PAGES[pathname]?.() ?? null;
}
