import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/local-subtitle/localSubtitleEnvironmentService", () => ({ getLocalSubtitleEnvironmentService: () => ({ getState: () => ({
  loading: false, runtime: { status: "ready" }, error: null, backendPreviewRevision: 0,
  resources: [{ resourceType: "model", status: "ready", displayName: "large-v3" }, { resourceType: "vad", status: "ready", displayName: "silero" }] }) }) }));
vi.mock("@/services/local-subtitle/localSubtitleRuntimeService", () => ({ getLocalSubtitleRuntimeService: () => ({ getState: () => ({
  syncStatus: "ready", revision: 1, resourceJobs: [], error: null, batches: [{ tasks: [{ displayName: "talk.mp4", status: "transcribing" }, { displayName: "done.mp4", status: "completed" }] }] }) }) }));

import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useSubtitleTranslatorConfigStore, { DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES } from "@/store/tools/subtitle/useSubtitleTranslatorConfigStore";
import useSubtitleConverterStore from "@/store/tools/subtitle/useSubtitleConverterStore";
import useNameTranslatorConfigStore, { DEFAULT_NAME_TRANSLATOR_CONFIG } from "@/store/tools/rename/nameTranslatorConfig";
import { LOCAL_SUBTITLE_TRANSCRIBER_ROUTE } from "@/constants/router";
import { classicPageContext } from "./classic-page-contexts";

const run = (context: ReturnType<typeof classicPageContext>, tool: string, input: unknown) => context!.tools![tool].execute!(input, { toolCallId: "t" }) as Promise<{ success: boolean; data?: any; error?: string }>;
afterEach(() => {
  useSubtitleTranslatorConfigStore.setState({ preferences: { ...DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES } });
  useNameTranslatorConfigStore.setState({ config: { ...DEFAULT_NAME_TRANSLATOR_CONFIG } });
});

describe("classic tool page contexts", () => {
  it("covers the five classic tools and nothing else", () => {
    for (const route of ["/tools/subtitle/translator", "/tools/subtitle/converter", "/tools/subtitle/extractor", LOCAL_SUBTITLE_TRANSCRIBER_ROUTE, "/tools/rename/name-translator"]) {
      const context = classicPageContext(route)!;
      expect(context.route).toBe(route);
      expect(context.suggestions).toHaveLength(2);
      expect(context.instructions).toBeTruthy();
    }
    expect(classicPageContext("/tools/subtitle/studio")).toBeNull();
    expect(classicPageContext("/")).toBeNull();
  });

  it("describes the translator's settings and queue", () => {
    useSubtitleTranslatorStore.setState({ notStartedTaskQueue: [{ fileName: "a.srt", progress: 0 }], pendingTaskQueue: [{ fileName: "b.srt", progress: 42.4 }],
      waitingTaskQueue: [], resolvedTaskQueue: [], failedTaskQueue: [] } as never);
    const snapshot = classicPageContext("/tools/subtitle/translator")!.describe!() as any;
    expect(snapshot.settings).toMatchObject({ sourceLang: "JA", targetLang: "ZH", translationOutputMode: "bilingual" });
    expect(snapshot.queue).toMatchObject({ total: 2, counts: { notStarted: 1, running: 1 }, tasks: [{ name: "a.srt", status: "notStarted", progress: 0 }, { name: "b.srt", status: "running", progress: 42 }] });
  });

  it("updates only the page's settings and reports before and after", async () => {
    const translator = classicPageContext("/tools/subtitle/translator");
    const result = await run(translator, "subtitle_translator_update_settings", { targetLang: "EN", translationOutputMode: "target_only" });
    expect(result).toEqual({ success: true, data: { changed: { targetLang: { before: "ZH", after: "EN" }, translationOutputMode: { before: "bilingual", after: "target_only" } } } });
    expect(useSubtitleTranslatorConfigStore.getState().preferences.targetLang).toBe("EN");
    expect(await run(translator, "subtitle_translator_update_settings", { targetLang: "XX" })).toEqual({ success: false, error: "invalid_tool_arguments" });
    expect(await run(translator, "subtitle_translator_update_settings", {})).toEqual({ success: false, error: "invalid_tool_arguments" });

    await run(classicPageContext("/tools/subtitle/converter"), "subtitle_converter_update_settings", { toFormat: "VTT" });
    expect(useSubtitleConverterStore.getState().toFormat).toBe("VTT");

    const names = classicPageContext("/tools/rename/name-translator");
    await run(names, "name_translator_update_settings", { nameMode: "bilingual", bilingualStyle: "bracket" });
    expect(useNameTranslatorConfigStore.getState().config).toMatchObject({ nameMode: "bilingual", bilingualStyle: "bracket" });
    expect((await run(names, "name_translator_update_settings", { customTemplate: "{original}" })).success).toBe(false);
  });

  it("describes the local transcriber's environment, draft and tasks", () => {
    const snapshot = classicPageContext(LOCAL_SUBTITLE_TRANSCRIBER_ROUTE)!.describe!() as any;
    expect(snapshot.environment).toEqual({ runtimeReady: true, loading: false, readyModels: ["large-v3"] });
    expect(snapshot.tasks).toMatchObject({ total: 2, counts: { transcribing: 1, completed: 1 } });
    expect(snapshot.settings).toHaveProperty("modelId");
  });
});
