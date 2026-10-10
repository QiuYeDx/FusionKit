import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Model } from "@/type/model";
import useAgentStore from "@/store/agent/useAgentStore";
import useModelStore from "@/store/useModelStore";
import useSubtitleTranslatorStore from "@/store/tools/subtitle/useSubtitleTranslatorStore";
import useSubtitleTranslatorConfigStore, { DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES } from "@/store/tools/subtitle/useSubtitleTranslatorConfigStore";
import useNameTranslatorConfigStore, { DEFAULT_NAME_TRANSLATOR_CONFIG } from "@/store/tools/rename/nameTranslatorConfig";
import * as agentNamePlan from "@/services/name-translation/agentPlan";
import {
  executeQueueRecoveredSubtitleTranslate,
  executeQueueTranslate,
  executeScanSubtitleRecoveryTasks,
  executeCreateNameTranslationPlan,
} from "./tool-executor";

it("passes cancellation into name planning and leaves no pending preview after cancellation", async () => {
  const controller = new AbortController();
  const planner = vi.spyOn(agentNamePlan, "createAgentNamePlan").mockImplementation(async (_args, signal) => {
    expect(signal).toBe(controller.signal);
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });
  const result = await executeCreateNameTranslationPlan({ roots: ["C:/names"], scope: "children", targetKind: "files" } as never, controller.signal);
  expect(result.success).toBe(false);
  expect(useAgentStore.getState().pendingNameTranslationPlan).toBeNull();
  planner.mockRestore();
});

const api = {
  selectAgentInputFiles: vi.fn(),
  authorizeAgentInputPaths: vi.fn(),
  authorizeOutputDirectoryPath: vi.fn(),
  scanRecoveryPath: vi.fn(),
  readAgentInputFile: vi.fn(),
  registerAgentAuthorizedTask: vi.fn(),
  revokeAgentInputSelection: vi.fn(),
  selectOutputDirectory: vi.fn(),
  revokeOutputDirectory: vi.fn(),
  selectRecoveryDirectory: vi.fn(),
  selectRecoveryManifest: vi.fn(),
  prepareRecoveredTasks: vi.fn(),
  revokeRecoveryScan: vi.fn(),
  releaseGeneratedTask: vi.fn(),
};

const originalWindow = globalThis.window;

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { subtitleTranslationApi: api },
  });
  useSubtitleTranslatorStore.getState().initializeSubtitleTranslatorStore();
  useAgentStore.setState({
    executionMode: "queue_only",
    pendingExecution: null,
    session: {
      id: "agent-test-session",
      messages: [{
        id: "user-one",
        role: "user",
        content: "翻译我选择的字幕",
        timestamp: 1,
      }],
      status: "idle",
      createdAt: 1,
      updatedAt: 1,
    },
  });
  useModelStore.setState({
    profiles: [{
      id: "task-profile",
      name: "Task profile",
      provider: Model.OpenAI,
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1",
      modelKey: "gpt-5",
      tokenPricing: {
        inputTokensPerMillion: 1,
        outputTokensPerMillion: 2,
      },
      apiFormat: "responses",
      outputTokenParameter: "max_completion_tokens",
    }],
    assignment: { agent: null, taskExecution: "task-profile" },
  });
  api.selectAgentInputFiles.mockResolvedValue({
    ok: true,
    data: {
      cancelled: false,
      selectionRef: "subtitle-translation-selection-agent",
      files: [{
        itemRef: "subtitle-translation-selection-item-agent",
        displayName: "selected.srt",
      }],
      expiresAt: Date.now() + 60_000,
    },
  });
  api.readAgentInputFile.mockResolvedValue({
    ok: true,
    data: { displayName: "selected.srt", content: "subtitle content" },
  });
  api.registerAgentAuthorizedTask.mockResolvedValue({
    ok: true,
    data: {
      kind: "authorized_task_v1",
      source: {
        kind: "authorized_file",
        token: "subtitle-translation-source-agent",
        displayName: "selected.srt",
      },
      target: {
        kind: "authorized_directory",
        token: "subtitle-translation-target-agent",
        displayLabel: "Selected source",
      },
    },
  });
  api.revokeAgentInputSelection.mockResolvedValue({
    ok: true,
    data: { revoked: false },
  });
  api.revokeOutputDirectory.mockResolvedValue({
    ok: true,
    data: { revoked: true },
  });
  api.revokeRecoveryScan.mockResolvedValue({
    ok: true,
    data: { released: true },
  });
  api.releaseGeneratedTask.mockResolvedValue({
    ok: true,
    data: { released: true },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("Agent subtitle translation producer", () => {
  it("revokes a picker selection returned after cancellation without queueing", async () => {
    const abort = new AbortController();
    const selected = await api.selectAgentInputFiles();
    api.selectAgentInputFiles.mockImplementation(async () => { abort.abort(); return selected; });
    const result = await executeQueueTranslate({ sliceType: "NORMAL", sourceLang: "JA", targetLang: "ZH", translationOutputMode: "bilingual", outputMode: "source", conflictPolicy: "index", concurrentSlices: true }, abort.signal);
    expect(result).toMatchObject({ success: false, data: { queuedCount: 0, cancelled: true } });
    expect(api.readAgentInputFile).not.toHaveBeenCalled();
    expect(api.registerAgentAuthorizedTask).not.toHaveBeenCalled();
    expect(api.revokeAgentInputSelection).toHaveBeenCalledWith(selected.data.selectionRef);
  });

  it("releases registered authority if cancellation arrives before queue admission", async () => {
    const abort = new AbortController();
    const registration = await api.registerAgentAuthorizedTask();
    api.registerAgentAuthorizedTask.mockImplementation(async () => { abort.abort(); return registration; });
    const result = await executeQueueTranslate({ sliceType: "NORMAL", sourceLang: "JA", targetLang: "ZH", translationOutputMode: "bilingual", outputMode: "source", conflictPolicy: "index", concurrentSlices: true }, abort.signal);
    expect(result).toMatchObject({ success: false, data: { queuedCount: 0 } });
    expect(api.releaseGeneratedTask).toHaveBeenCalled();
    expect(useSubtitleTranslatorStore.getState().notStartedTaskQueue).toHaveLength(0);
  });

  it("queues only picker-authorized path-free tasks", async () => {
    const result = await executeQueueTranslate({
      sliceType: "NORMAL",
      sourceLang: "JA",
      targetLang: "ZH",
      translationOutputMode: "bilingual",
      outputMode: "source",
      conflictPolicy: "index",
      concurrentSlices: true,
    });

    expect(result).toMatchObject({
      success: true,
      data: { queuedCount: 1, totalFiles: 1, executionStatus: "queued_only" },
    });
    expect(api.readAgentInputFile).toHaveBeenCalledWith({
      selectionRef: "subtitle-translation-selection-agent",
      itemRef: "subtitle-translation-selection-item-agent",
    });
    expect(api.registerAgentAuthorizedTask).toHaveBeenCalledWith(expect.objectContaining({
      selectionRef: "subtitle-translation-selection-agent",
      itemRef: "subtitle-translation-selection-item-agent",
      outputMode: "source",
      outputFileName: "selected.srt",
    }));
    expect(api.revokeAgentInputSelection).toHaveBeenCalledWith(
      "subtitle-translation-selection-agent",
    );
    const [task] = useSubtitleTranslatorStore.getState().notStartedTaskQueue;
    expect(task).toMatchObject({
      fileName: "selected.srt",
      taskReference: { kind: "authorized_task_v1" },
    });
    expect(task).not.toHaveProperty("originFileURL");
    expect(task).not.toHaveProperty("targetFileURL");
  });

  it.each([
    { filePaths: ["/private/input.srt"] },
    { scanId: "scan-renderer" },
    { outputDir: "/private/output" },
  ])("rejects legacy renderer authority before opening a picker: %o", async (legacy) => {
    const result = await executeQueueTranslate({
      sliceType: "NORMAL",
      sourceLang: "JA",
      targetLang: "ZH",
      translationOutputMode: "bilingual",
      outputMode: "source",
      conflictPolicy: "index",
      concurrentSlices: true,
      ...legacy,
    } as never);

    expect(result).toMatchObject({ success: false });
    expect(api.selectAgentInputFiles).not.toHaveBeenCalled();
  });
});

describe("paths the user typed", () => {
  const folder = "D:/字幕/第一季";
  const typed = (content: string) => useAgentStore.setState({ session: { ...useAgentStore.getState().session,
    messages: [{ id: "user-typed", role: "user", content, timestamp: 2 }] } });
  const base = { sliceType: "NORMAL" as const, sourceLang: "JA" as const, targetLang: "ZH" as const, translationOutputMode: "bilingual" as const, conflictPolicy: "index" as const, concurrentSlices: true };

  it("translates the subtitles under a typed folder and saves to a typed output folder, without a picker", async () => {
    typed(`把 ${folder} 里的字幕翻译成中文，保存到 D:/输出`);
    api.authorizeAgentInputPaths.mockResolvedValueOnce(await api.selectAgentInputFiles());
    api.authorizeOutputDirectoryPath.mockResolvedValueOnce({ ok: true, data: { cancelled: false, directoryToken: "subtitle-translation-directory-typed", displayLabel: "输出", expiresAt: Date.now() + 60_000 } });
    const result = await executeQueueTranslate({ ...base, paths: [folder], recursive: true, outputDirectory: "D:/输出" });
    expect(result).toMatchObject({ success: true, data: { queuedCount: 1 } });
    expect(api.authorizeAgentInputPaths).toHaveBeenCalledWith({ paths: [folder], recursive: true });
    expect(api.authorizeOutputDirectoryPath).toHaveBeenCalledWith({ directoryPath: "D:/输出" });
    expect(api.selectAgentInputFiles).toHaveBeenCalledTimes(1);
    expect(api.selectOutputDirectory).not.toHaveBeenCalled();
    expect(api.registerAgentAuthorizedTask).toHaveBeenCalledWith(expect.objectContaining({ outputMode: "custom", directoryToken: "subtitle-translation-directory-typed" }));
  });

  it("refuses a path the user did not type and reports a folder without subtitles", async () => {
    typed(`把 ${folder} 里的字幕翻译成中文`);
    expect(await executeQueueTranslate({ ...base, paths: ["D:/私人"] })).toMatchObject({ success: false, error: "translation_path_not_typed" });
    expect(await executeQueueTranslate({ ...base, paths: [folder], outputDirectory: "C:/Windows" })).toMatchObject({ success: false, error: "translation_path_not_typed" });
    expect(api.authorizeAgentInputPaths).not.toHaveBeenCalled();
    api.authorizeAgentInputPaths.mockResolvedValueOnce({ ok: true, data: { cancelled: true, matched: 0 } });
    expect(await executeQueueTranslate({ ...base, paths: [folder] })).toMatchObject({ success: false, error: "translation_no_subtitles_found" });
  });

  it("scans a typed recovery folder instead of opening the picker", async () => {
    typed(`继续 ${folder} 里没翻译完的字幕`);
    api.scanRecoveryPath.mockResolvedValueOnce({ ok: true, data: { cancelled: false, recoveryScanId: "recovery-scan-typed", candidates: [], totalCount: 0,
      recoverableCount: 0, scannedDirs: 1, scannedFiles: 0, skippedFiles: 0, truncated: false, errors: [], expiresAt: Date.now() + 60_000 } });
    const result = await executeScanSubtitleRecoveryTasks({ path: folder, selectionMode: "directory", includeCompleted: false });
    expect(api.scanRecoveryPath).toHaveBeenCalledWith({ path: folder, includeCompleted: false });
    expect(api.selectRecoveryDirectory).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).toContain("recovery-scan-typed");
    expect(await executeScanSubtitleRecoveryTasks({ path: "E:/别处", selectionMode: "directory", includeCompleted: false })).toMatchObject({ success: false, error: "recovery_path_not_typed" });
  });
});

describe("Agent subtitle translation recovery", () => {
  it.each([
    {
      selectionMode: "directory" as const,
      method: "selectRecoveryDirectory" as const,
    },
    {
      selectionMode: "manifest" as const,
      method: "selectRecoveryManifest" as const,
    },
  ])("uses the fixed $selectionMode picker and returns only opaque scan data", async ({
    selectionMode,
    method,
  }) => {
    api[method].mockResolvedValueOnce({
      ok: true,
      data: {
        cancelled: false,
        recoveryScanId: "recovery-scan-agent",
        candidates: [{
          candidateId: "recovery-candidate-agent",
          checkpointRef: "checkpoint-agent",
          fileName: "recoverable.srt",
          schemaVersion: 2,
          manifestStatus: "failed",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:01:00.000Z",
          outputDirectoryLabel: "Recovery",
          options: {
            fileType: "SRT",
            sliceType: "NORMAL",
            sourceLang: "JA",
            targetLang: "ZH",
            translationOutputMode: "bilingual",
          },
          resolvedFragments: 1,
          totalFragments: 2,
          progress: 50,
          recoverability: "ready_from_manifest",
        }],
        totalCount: 1,
        recoverableCount: 1,
        scannedDirs: 1,
        scannedFiles: 1,
        skippedFiles: 0,
        truncated: false,
        errors: [],
        expiresAt: Date.now() + 60_000,
      },
    });

    const result = await executeScanSubtitleRecoveryTasks({
      selectionMode,
      includeCompleted: false,
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        recoveryScanId: "recovery-scan-agent",
        candidates: [{ checkpointRef: "checkpoint-agent" }],
      },
    });
    expect(api[method]).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("/private/");
  });

  it.each([false, true])("reauthorizes recovery and preserves its receipt across a session reset: %s", async (resetDuringCleanup) => {
    api.selectOutputDirectory.mockResolvedValueOnce({
      ok: true,
      data: {
        cancelled: false,
        directoryToken: "recovery-directory-agent",
        displayLabel: "New output",
        expiresAt: Date.now() + 60_000,
      },
    });
    api.prepareRecoveredTasks.mockResolvedValueOnce({
      ok: true,
      data: {
        tasks: [{
          taskId: "subtitle-task-recovered-agent",
          fileName: "recoverable.srt",
          sliceType: "NORMAL",
          sourceLang: "JA",
          targetLang: "ZH",
          translationOutputMode: "bilingual",
          resolvedFragments: 1,
          totalFragments: 2,
          progress: 50,
          checkpointRef: "checkpoint-agent",
          reference: {
            kind: "generated_task_v1",
            source: {
              kind: "generated_content",
              displayName: "recoverable.srt",
            },
            target: {
              kind: "authorized_directory",
              token: "recovery-target-agent",
              displayLabel: "New output",
            },
          },
        }],
        totalCandidates: 1,
        batchStart: 0,
        batchEnd: 1,
        hasMore: false,
        nextBatchStart: null,
      },
    });

    if (resetDuringCleanup) api.revokeRecoveryScan.mockImplementationOnce(async () => {
      useAgentStore.getState().resetSession();
      return { ok: true, data: { released: true } };
    });
    const result = await executeQueueRecoveredSubtitleTranslate({
      recoveryScanId: "recovery-scan-agent",
      batchStart: 0,
      batchSize: 10,
      conflictPolicy: "index",
      concurrentSlices: true,
    });

    expect(api.prepareRecoveredTasks).toHaveBeenCalledWith({
      recoveryScanId: "recovery-scan-agent",
      directoryToken: "recovery-directory-agent",
      batchStart: 0,
      batchSize: 10,
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        queuedCount: 1,
        batch: {
          recoveryScanId: "recovery-scan-agent",
          batchStart: 0,
          batchEnd: 1,
          hasMore: false,
          queuedCount: 1,
        },
      },
    });
    expect(Object.prototype.hasOwnProperty.call(result.data.batch, "tasks"))
      .toBe(false);
    expect(api.revokeRecoveryScan).toHaveBeenCalledWith("recovery-scan-agent");
    const [task] = useSubtitleTranslatorStore.getState().notStartedTaskQueue;
    expect(task).toMatchObject({
      taskId: "subtitle-task-recovered-agent",
      checkpointRef: "checkpoint-agent",
      taskReference: { kind: "generated_task_v1" },
    });
    expect(task).not.toHaveProperty("checkpointPath");
    expect(task).not.toHaveProperty("targetFileURL");
    if (resetDuringCleanup) {
      expect(useAgentStore.getState().sessionLog).toEqual([]);
      expect(useAgentStore.getState().pendingExecution).toBeNull();
      expect(result.data).toMatchObject({ cancelled: true, queuedCount: 1 });
    }
  });

  it("asks for the output directory once across batches of the same scan", async () => {
    const batch = (index: number, hasMore: boolean) => ({
      ok: true,
      data: {
        tasks: [{
          taskId: `subtitle-task-batch-${index}`, fileName: `batch-${index}.srt`, sliceType: "NORMAL",
          sourceLang: "JA", targetLang: "ZH", translationOutputMode: "bilingual",
          resolvedFragments: 1, totalFragments: 2, progress: 50, checkpointRef: `checkpoint-batch-${index}`,
          reference: {
            kind: "generated_task_v1",
            source: { kind: "generated_content", displayName: `batch-${index}.srt` },
            target: { kind: "authorized_directory", token: `target-batch-${index}`, displayLabel: "Output" },
          },
        }],
        totalCandidates: 2, batchStart: index, batchEnd: index + 1, hasMore, nextBatchStart: hasMore ? index + 1 : null,
      },
    });
    api.selectOutputDirectory.mockResolvedValueOnce({
      ok: true,
      data: { cancelled: false, directoryToken: "shared-recovery-directory", displayLabel: "Output", expiresAt: Date.now() + 60_000 },
    });
    api.prepareRecoveredTasks.mockResolvedValueOnce(batch(0, true)).mockResolvedValueOnce(batch(1, false));
    const queue = (batchStart: number) => executeQueueRecoveredSubtitleTranslate({
      recoveryScanId: "recovery-scan-batches", batchStart, batchSize: 1, conflictPolicy: "index", concurrentSlices: true,
    });

    await expect(queue(0)).resolves.toMatchObject({ success: true, data: { batch: { hasMore: true } } });
    expect(api.revokeOutputDirectory).not.toHaveBeenCalled();
    await expect(queue(1)).resolves.toMatchObject({ success: true, data: { batch: { hasMore: false } } });
    expect(api.selectOutputDirectory).toHaveBeenCalledTimes(1);
    expect(api.prepareRecoveredTasks.mock.calls.map(([request]) => request.directoryToken))
      .toEqual(["shared-recovery-directory", "shared-recovery-directory"]);
    expect(api.revokeOutputDirectory).toHaveBeenCalledWith("shared-recovery-directory");
  });

  it("releases a retained recovery directory when the session changes", async () => {
    api.selectOutputDirectory.mockResolvedValueOnce({
      ok: true,
      data: { cancelled: false, directoryToken: "retained-recovery-directory", displayLabel: "Output", expiresAt: Date.now() + 60_000 },
    });
    api.prepareRecoveredTasks.mockResolvedValueOnce({
      ok: true,
      data: { tasks: [], totalCandidates: 3, batchStart: 0, batchEnd: 1, hasMore: true, nextBatchStart: 1 },
    });
    await executeQueueRecoveredSubtitleTranslate({
      recoveryScanId: "recovery-scan-retained", batchStart: 0, batchSize: 1, conflictPolicy: "index", concurrentSlices: true,
    });
    expect(api.revokeOutputDirectory).not.toHaveBeenCalled();
    useAgentStore.getState().resetSession();
    await vi.waitFor(() => expect(api.revokeOutputDirectory).toHaveBeenCalledWith("retained-recovery-directory"));
  });

  it("stops on target cancellation and revokes an unused target after prepare fails", async () => {
    api.selectOutputDirectory.mockResolvedValueOnce({
      ok: true,
      data: { cancelled: true },
    });
    const cancelled = await executeQueueRecoveredSubtitleTranslate({
      recoveryScanId: "recovery-scan-agent",
      batchStart: 0,
      batchSize: 10,
      conflictPolicy: "index",
      concurrentSlices: true,
    });
    expect(cancelled).toMatchObject({ success: false });
    expect(api.prepareRecoveredTasks).not.toHaveBeenCalled();

    api.selectOutputDirectory.mockResolvedValueOnce({
      ok: true,
      data: {
        cancelled: false,
        directoryToken: "unused-recovery-directory",
        displayLabel: "Unused output",
        expiresAt: Date.now() + 60_000,
      },
    });
    api.prepareRecoveredTasks.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "authorization_expired",
        message: "Recovery scan expired.",
      },
    });
    const failed = await executeQueueRecoveredSubtitleTranslate({
      recoveryScanId: "recovery-scan-agent",
      batchStart: 0,
      batchSize: 10,
      conflictPolicy: "index",
      concurrentSlices: true,
    });
    expect(failed).toMatchObject({
      success: false,
      error: "Recovery scan expired.",
    });
    expect(api.revokeOutputDirectory).toHaveBeenCalledWith(
      "unused-recovery-directory",
    );
  });
});

describe("settings the request leaves out follow the tool pages", () => {
  afterEach(() => {
    useSubtitleTranslatorConfigStore.setState({ preferences: { ...DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES } });
    useNameTranslatorConfigStore.setState({ config: { ...DEFAULT_NAME_TRANSLATOR_CONFIG } });
  });

  it("queues translation with the translator page's current settings and reports their sources", async () => {
    useSubtitleTranslatorConfigStore.setState({ preferences: { ...DEFAULT_SUBTITLE_TRANSLATOR_CONFIG_PREFERENCES,
      sourceLang: "EN", targetLang: "JA", translationOutputMode: "target_only", sliceType: "SENSITIVE", conflictPolicy: "overwrite",
      concurrentSlices: false, thinkingEnabled: true, outputMode: "custom" } as never });
    const result = await executeQueueTranslate({ targetLang: "KO" } as never);
    expect(result.success).toBe(true);
    const task = useSubtitleTranslatorStore.getState().notStartedTaskQueue.at(-1)!;
    expect(task).toMatchObject({ sourceLang: "EN", targetLang: "KO", translationOutputMode: "target_only", sliceType: "SENSITIVE", conflictPolicy: "overwrite", concurrentSlices: false });
    // The page's output folder needs a new authorization: the task is saved next to its input.
    expect(api.selectOutputDirectory).not.toHaveBeenCalled();
    expect(api.registerAgentAuthorizedTask).toHaveBeenCalledWith(expect.objectContaining({ outputMode: "source" }));
    expect(result.data).toMatchObject({
      appliedSettings: {
        sourceLang: { value: "EN", source: "tool_page" }, targetLang: { value: "KO", source: "user" },
        conflictPolicy: { value: "overwrite", source: "tool_page" }, thinkingEnabled: { value: true, source: "tool_page" },
        outputMode: { value: "source", source: "default" },
      },
      outputNote: "saved_next_to_inputs_translator_page_folder_needs_picking",
    });
  });

  it("still requires the user's words for an overwrite the model asks for", async () => {
    const result = await executeQueueTranslate({ conflictPolicy: "overwrite" } as never);
    expect(useSubtitleTranslatorStore.getState().notStartedTaskQueue.at(-1)!.conflictPolicy).toBe("index");
    expect(result.data).toMatchObject({ conflictPolicyAdjusted: "overwrite_requires_explicit_user_request" });
  });

  it("plans name translation with the name translator page's format and languages", async () => {
    useNameTranslatorConfigStore.setState({ config: { ...DEFAULT_NAME_TRANSLATOR_CONFIG, targetLang: "EN", nameMode: "bilingual",
      bilingualOrder: "original_first", bilingualStyle: "bracket", includeHidden: true, instructions: "保留人名" } as never });
    const planner = vi.spyOn(agentNamePlan, "createAgentNamePlan").mockResolvedValue({ planId: "p", totalTargets: 0, previewLimit: 20, itemsPreview: [],
      readyCount: 0, blockedCount: 0, skippedCount: 0, unchangedCount: 0, warnings: [], applyable: false } as never);
    const result = await executeCreateNameTranslationPlan({ roots: ["C:/names"], scope: "children", targetKind: "files" } as never);
    expect(planner.mock.calls[0][0]).toMatchObject({ targetLang: "EN", includeHidden: true, instructions: "保留人名",
      format: { nameMode: "bilingual", bilingualOrder: "original_first", bilingualStyle: "bracket" } });
    expect(result.data).toMatchObject({ appliedSettings: { nameFormat: { source: "tool_page" }, targetLang: { value: "EN", source: "tool_page" } } });
    planner.mockRestore();
  });
});
